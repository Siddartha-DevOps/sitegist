import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/database/db.server";
import { streamRAG, generateFollowUpSuggestions, analyzeSentiment } from "~/ai-layer/ai.server";
import { getRedis } from "~/lib/redis.server";
import { sendWebhook, webhookEventEnabled } from "~/lib/webhook.server";
import { pickAgentEmail } from "~/backend/routing.server";
import { notifySlackEscalation } from "~/lib/slack.server";
import { getUsageForUser } from "~/lib/usage.server";
import { captureException } from "~/lib/monitoring.server";
import { isOriginAllowed, originHost } from "~/lib/domains";
import { createWidgetSessionToken, verifyWidgetSessionToken } from "~/lib/widget-session.server";
import { broadcastRealtime, createRealtimeClientToken } from "~/lib/partykit.server";

const HISTORY_CHAR_BUDGET = 6000;
// Reject oversized messages: bounds memory/storage and caps LLM token cost (a
// single huge message could otherwise be a cheap DoS / cost-amplification vector).
const MAX_MESSAGE_CHARS = 8000;

/**
 * Strict (default-deny) mode is opt-in via WIDGET_STRICT_DOMAINS=1 (global) or a
 * project's settings.strictDomains. When a chatbot has NO allowedDomains configured,
 * strict mode denies all cross-origin callers and permits only same-origin requests
 * (i.e. the SiteGist-hosted embed iframe), instead of the default allow-all.
 */
function isStrictDomainMode(settings: any): boolean {
  return process.env.WIDGET_STRICT_DOMAINS === "1" || settings?.strictDomains === true;
}

// Score a user message's sentiment without blocking the chat response.
function scoreSentimentAsync(messageId: string, text: string) {
  analyzeSentiment(text)
    .then((sentiment) =>
      prisma.message.update({ where: { id: messageId }, data: { sentiment } })
    )
    .catch((e) => console.warn("[Sentiment] async update failed:", e));
}

export async function action({ request }: ActionFunctionArgs) {
  console.log(`[Chat Action] Incoming request: ${request.method} ${request.url}`);
  
  // Verify it's a POST request
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json().catch(err => {
      console.error("[Chat] Failed to parse JSON body:", err);
      return null;
    });

    if (!body) {
      return json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { projectId, message, sessionId, sessionToken: providedSessionToken, pageUrl, pageTitle } = body;

    if (!projectId || !message) {
      return json({ error: "Missing required fields (projectId, message)" }, { status: 400 });
    }

    if (typeof message !== "string" || message.length > MAX_MESSAGE_CHARS) {
      return json({ error: `Message too long (max ${MAX_MESSAGE_CHARS} characters).` }, { status: 400 });
    }

    // --- Domain Whitelisting ---
    const origin = request.headers.get("origin") || request.headers.get("referer");
    // ---------------------------

    console.log(`[Chat] Processing request for project: ${projectId}, session: ${sessionId || 'new'}`);

    let project = null;
    let systemPrompt = "You are a helpful AI assistant for SiteGist, a platform that builds AI chatbots from website content.";
    let modelPreference: string | undefined = undefined;
    let responseLanguage: string | undefined = undefined;
    let chatMode: 'ai-only' | 'hybrid' | 'agent-only' = 'ai-only';

    if (projectId !== "demo-project") {
      try {
        project = await prisma.project.findUnique({
          where: { id: projectId },
        });

        if (!project) {
          console.warn(`[Chat] Project not found: ${projectId}`);
          return json({ error: "Project not found" }, { status: 404 });
        }
        const settings = project.settings as any;
        systemPrompt = settings?.systemPrompt || systemPrompt;
        modelPreference = settings?.model || undefined;
        responseLanguage = settings?.language || undefined;
        chatMode = settings?.chatMode || 'ai-only';

        // Domain whitelisting check (exact host / subdomain match — see isOriginAllowed).
        const allowedDomains: string[] = settings?.allowedDomains || [];
        if (allowedDomains.length > 0) {
          if (!isOriginAllowed(origin, allowedDomains)) {
            console.warn(`[Chat] Unauthorized domain access: ${origin || "(no origin)"}`);
            return json({ error: "Unauthorized domain" }, { status: 403 });
          }
        } else if (isStrictDomainMode(settings)) {
          // Default-deny: with no allowlist configured, permit only same-origin
          // (the SiteGist-hosted embed) and reject external direct callers.
          const reqHost = originHost(request.url);
          if (originHost(origin) !== reqHost) {
            console.warn(`[Chat] Strict mode blocked cross-origin request: ${origin || "(no origin)"}`);
            return json({ error: "Unauthorized domain" }, { status: 403 });
          }
        }
      } catch (dbError) {
        console.error("[Chat] Database error fetching project:", dbError);
      }
    }

    if (projectId !== "demo-project" && project) {
      try {
        const owner = await prisma.user.findUnique({ where: { id: project.userId } });
        const usage = await getUsageForUser(project.userId, owner?.subscriptionTier);
        if (!usage.unlimited && usage.used >= usage.limit) {
          return json({ error: "quota_exceeded", message: "This chatbot has reached its monthly message limit. Please try again later." }, { status: 429 });
        }
      } catch (quotaErr) {
        // Fail CLOSED: if we can't confirm the account is under quota, don't
        // serve a (billable) LLM call. Protects revenue and the LLM bill.
        console.error("[Chat] Quota check failed (failing closed):", quotaErr);
        captureException(quotaErr, { where: "api.chat.quota", projectId });
        return json(
          { error: "temporarily_unavailable", message: "We're having trouble right now. Please try again in a moment." },
          { status: 503 }
        );
      }
    }

    const settings = project?.settings as any;
    const rateLimitPerUser = parseInt(settings?.rateLimitPerUser || "0", 10);
    const rateLimitWindow = settings?.rateLimitWindow || "day";
    let count = 0;

    // Visitor IP + Redis are shared by the global and per-project rate limits.
    const visitorIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
      'unknown';
    const redis = getRedis();

    // Global per-IP ceiling — abuse / cost protection that applies to EVERY bot,
    // even those without a per-project limit configured. Default 30/min; tune via
    // GLOBAL_RATE_LIMIT_PER_MIN (0 disables). Requires Redis to enforce.
    if (projectId !== "demo-project" && redis) {
      const globalPerMin = parseInt(process.env.GLOBAL_RATE_LIMIT_PER_MIN || "30", 10);
      if (globalPerMin > 0) {
        try {
          const gKey = `ratelimit:global:${projectId}:${visitorIp}`;
          const gCount = await redis.incr(gKey);
          if (gCount === 1) await redis.expire(gKey, 60);
          if (gCount > globalPerMin) {
            return json(
              { error: "rate_limited", message: "Too many requests. Please slow down and try again shortly." },
              { status: 429 }
            );
          }
        } catch (e) {
          console.warn("[Global Rate Limit] failed:", e);
        }
      }
    } else if (projectId !== "demo-project" && !redis) {
      console.warn("[Rate Limit] Redis not configured — global abuse protection is OFF. Set UPSTASH_REDIS_* to enable.");
    }

    if (projectId !== "demo-project" && rateLimitPerUser > 0) {
      if (redis) {
        const windowSeconds = rateLimitWindow === 'hour' ? 3600 : 86400;
        const redisKey = `ratelimit:${projectId}:${visitorIp}`;

        try {
          count = await redis.incr(redisKey);
          if (count === 1) {
            await redis.expire(redisKey, windowSeconds);
          }

          if (count > rateLimitPerUser) {
            const resetLabel = rateLimitWindow === 'hour' ? 'this hour' : 'today';
            return json(
              {
                error: "rate_limited",
                message: `You've reached the message limit ${resetLabel}. Please check back later.`,
              },
              { status: 429 }
            );
          }
        } catch (redisError) {
          console.warn("[Redis Rate Limit Error] Failed:", redisError);
        }
      } else {
        console.warn("[Redis Rate Limit] Redis client not initialized. Skipping limit.");
      }
    }

    // 1. Get or create session
    let session: any = null;
    let issuedSessionToken: string | null = null;
    let realtimeToken: string | null = null;
    let formattedHistory: { role: string, content: string }[] = [];

    if (projectId !== "demo-project") {
      try {
        if (sessionId && verifyWidgetSessionToken(providedSessionToken, String(sessionId), String(projectId))) {
          // Scope the session to this project — a sessionId from another
          // project must not be resumable here, or a visitor could replay/
          // continue another tenant's conversation by supplying its id.
          // If it doesn't match, session stays null and a fresh one is created
          // for this project below.
          session = await prisma.chatSession.findFirst({ where: { id: sessionId, projectId } });
        }
        
        if (!session) {
          session = await prisma.chatSession.create({
            data: {
              projectId,
              ...(pageUrl ? { pageUrl: String(pageUrl).slice(0, 2048) } : {}),
              ...(pageTitle ? { pageTitle: String(pageTitle).slice(0, 512) } : {}),
            },
          });
        }

        issuedSessionToken = createWidgetSessionToken(session.id, projectId);
        realtimeToken = await createRealtimeClientToken(session.id, "visitor");

        // If session is in human mode, AI should not respond
        if (session.mode === "human") {
          console.log(`[Chat] Session ${session.id} is in HUMAN mode. Skipping AI.`);
          // Log user message first
          const humanModeUserMsg = await prisma.message.create({
            data: {
              sessionId: session.id,
              role: "user",
              content: message,
            },
          });
          scoreSentimentAsync(humanModeUserMsg.id, message);

          // Broadcast visitor message to PartyKit room live
          broadcastRealtime(session.id, { type: "message", role: "user", content: message })
            .catch((err) => console.error("[api.chat.ts] PartyKit broadcast error:", err));
          
          return new Response(new ReadableStream({
             start(controller) {
               const authData = JSON.stringify({ sessionId: session.id, sessionToken: issuedSessionToken, realtimeToken, chatMode });
               controller.enqueue(new TextEncoder().encode(`event: session\ndata: ${authData}\n\n`));
               const data = JSON.stringify({ content: "Our support team has taken over this chat and will respond shortly." });
               controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${data}\n\n`));
               controller.close();
             }
          }), { headers: { "Content-Type": "text/event-stream" } });
        }

        // 2. Fetch history
        const history = await prisma.message.findMany({
          where: { sessionId: session.id },
          orderBy: { createdAt: 'desc' },
          take: 20,
        });

        const selectedMessages = [];
        let runningTotal = 0;
        for (const m of history) {
          const length = m.content ? m.content.length : 0;
          if (runningTotal + length > HISTORY_CHAR_BUDGET && selectedMessages.length > 0) {
            break;
          }
          runningTotal += length;
          selectedMessages.push(m);
        }

        formattedHistory = selectedMessages.reverse().map(m => ({ role: m.role, content: m.content }));

        // 3. Log user message
        const userMsg = await prisma.message.create({
          data: {
            sessionId: session.id,
            role: "user",
            content: message,
          },
        });
        scoreSentimentAsync(userMsg.id, message);

        // message.received webhook (opt-in; fire-and-forget so it never adds
        // latency to or blocks the chat stream).
        if (project?.webhookUrl && webhookEventEnabled(settings, "message.received")) {
          sendWebhook(
            project.webhookUrl,
            "message.received",
            { id: project.id, name: project.name },
            { session: { id: session.id }, message: { id: userMsg.id, role: "user", content: message, createdAt: userMsg.createdAt.toISOString() } }
          ).catch((e) => console.warn("[Webhook] message.received (user) failed:", e));
        }
      } catch (dbError) {
        console.error("[Chat] Database error in session management:", dbError);
        return json({ error: "Unable to start chat session" }, { status: 503 });
      }
    }

    const encoder = new TextEncoder();
    
    // Create the ReadableStream
    const stream = new ReadableStream({
      async start(controller) {
        console.log(`[Chat] Stream started for project: ${projectId}`);
        let fullAnswer = "";
        
        try {
          // Send initial session event
          const initialData = JSON.stringify({
            sessionId: session?.id || "demo-session",
            sessionToken: issuedSessionToken,
            realtimeToken,
            chatMode,
          });
          controller.enqueue(encoder.encode(`event: session\ndata: ${initialData}\n\n`));

          if (projectId !== "demo-project" && rateLimitPerUser > 0) {
            const remaining = Math.max(0, rateLimitPerUser - count);
            controller.enqueue(encoder.encode(`event: ratelimit\ndata: ${JSON.stringify({ remaining, window: rateLimitWindow })}\n\n`));
          }

          // Agent-only: skip AI entirely, route straight to human queue
          if (chatMode === 'agent-only') {
            if (projectId !== "demo-project" && session) {
              // Agent routing: assign the escalated conversation per settings.escalation.routing.
              const routingMode = (settings?.escalation?.routing?.mode) || "off";
              const assignedTo = await pickAgentEmail(projectId, routingMode).catch(() => null);
              await prisma.chatSession.update({
                where: { id: session.id },
                data: { mode: 'human', isRead: false, ...(assignedTo ? { assignedTo } : {}) },
              });

              if (project?.webhookUrl && webhookEventEnabled(settings, 'conversation.escalated')) {
                await sendWebhook(project.webhookUrl, 'conversation.escalated', {
                  id: project.id,
                  name: project.name,
                }, {
                  session: { id: session.id },
                  trigger: 'visitor_requested',
                  message,
                  ...(assignedTo ? { assignedTo } : {}),
                });
              }

              const slackWebhookUrl = (settings as any)?.slackWebhookUrl;
              if (slackWebhookUrl) {
                await notifySlackEscalation(slackWebhookUrl, {
                  projectName: project?.name || "Support Bot",
                  projectId: project?.id || projectId,
                  sessionId: session.id,
                  trigger: 'visitor_requested',
                  previewMessage: message,
                }).catch(() => {});
              }
            }

            controller.enqueue(encoder.encode(`event: agent-mode\ndata: ${JSON.stringify({ sessionId: session?.id || "demo-session" })}\n\n`));
            controller.close();
            return;
          }

          console.log(`[Chat] Initiating RAG for project: ${projectId}`);
          const ragStream = streamRAG(projectId, message, systemPrompt, formattedHistory, modelPreference, undefined, responseLanguage);
          
          // Check for handoff intent
          // Configurable escalation keywords (settings.escalation.keywords), falling
          // back to the built-in defaults when none are configured.
          const configuredKeywords = (settings?.escalation?.keywords as string[] | undefined)?.map(k => k.trim().toLowerCase()).filter(Boolean);
          const handoffKeywords = (configuredKeywords && configuredKeywords.length > 0)
            ? configuredKeywords
            : ["human", "agent", "real person", "support rep", "talk to someone", "help me"];
          const isHandoffRequested = handoffKeywords.some(keyword => message.toLowerCase().includes(keyword));

          if (isHandoffRequested && project?.webhookUrl && webhookEventEnabled(settings, 'conversation.escalated')) {
            console.log(`[Chat] Handoff requested for project: ${projectId}. Triggering webhook.`);
            await sendWebhook(project.webhookUrl, 'conversation.escalated', {
              id: project.id,
              name: project.name,
            }, {
              session: { id: session?.id },
              trigger: 'keyword_match',
              message,
            });
            
            // Optionally insert a marker in the stream or modify the response
            controller.enqueue(encoder.encode(`event: handoff\ndata: ${JSON.stringify({ requested: true })}\n\n`));
          }

          const slackWebhookUrl = (settings as any)?.slackWebhookUrl;
          if (isHandoffRequested && slackWebhookUrl) {
            notifySlackEscalation(slackWebhookUrl, {
              projectName: project?.name || "Support Bot",
              projectId: projectId,
              sessionId: session?.id ?? '',
              trigger: 'keyword_match',
              previewMessage: message,
            }).catch(() => {});
          }

          for await (const chunk of ragStream) {
            if (chunk.startsWith("ACTION:")) {
              // Agentic action(s) ran server-side; surface which ones to the widget.
              try {
                const payload = JSON.parse(chunk.slice(7).trim());
                controller.enqueue(encoder.encode(`event: action\ndata: ${JSON.stringify(payload)}\n\n`));
              } catch {
                /* ignore malformed action metadata */
              }
              continue;
            }
            if (chunk.startsWith("METADATA:")) {
              const raw = chunk.slice(9).trim();
              let sources: { source: string; title?: string; type?: string }[] = [];

              try {
                const parsed = JSON.parse(raw);
                if (parsed && Array.isArray(parsed.citations)) {
                  sources = parsed.citations.map((c: any) => ({
                    source: c.url || c.source || "",
                    title: c.title || "",
                    type: c.type || (c.url?.startsWith("http") ? "web" : "file"),
                  }));
                } else if (Array.isArray(parsed)) {
                  sources = parsed.map((c: any) => {
                    if (typeof c === "string") return { source: c };
                    return {
                      source: c.source || c.url || "",
                      title: c.title || "",
                      type: c.type || (c.source?.startsWith("http") || c.url?.startsWith("http") ? "web" : "file")
                    };
                  });
                } else if (parsed && typeof parsed === "object") {
                  if (parsed.source) {
                    sources = [{
                      source: parsed.source,
                      title: parsed.title,
                      type: parsed.type || (parsed.source.startsWith("http") ? "web" : "file")
                    }];
                  } else if (parsed.url) {
                    sources = [{
                      source: parsed.url,
                      title: parsed.title,
                      type: parsed.type || (parsed.url.startsWith("http") ? "web" : "file")
                    }];
                  }
                } else if (typeof parsed === "string") {
                  sources = [{ source: parsed }];
                }
              } catch {
                sources = raw ? [{ source: raw }] : [];
              }

              // Deduplicate by source URL and filter out placeholder values
              const seen = new Set<string>();
              const cleanedSources = sources.filter(s => {
                if (!s.source) return false;
                const src = s.source.trim();
                if (src === "knowledge" || src === "qa" || src === "internal") return false;
                if (seen.has(src)) return false;
                seen.add(src);
                return true;
              });

              if (cleanedSources.length > 0) {
                controller.enqueue(
                  encoder.encode(
                    `event: metadata\ndata: ${JSON.stringify({ sources: cleanedSources })}\n\n`
                  )
                );
              }
              continue;
            }
            fullAnswer += chunk;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`));
          }
          
          console.log(`[Chat] RAG finished, total length: ${fullAnswer.length}`);

          if (fullAnswer) {
            try {
              const suggestions = await generateFollowUpSuggestions(message, fullAnswer);
              if (suggestions && suggestions.length > 0) {
                controller.enqueue(encoder.encode(`event: suggestions\ndata: ${JSON.stringify(suggestions)}\n\n`));
              }
            } catch (e) {
              console.error("[Chat] Failed to generate follow up suggestions:", e);
            }
          }

          if (projectId !== "demo-project" && session && project) {
            try {
              const assistantMsg = await prisma.message.create({
                data: {
                  sessionId: session.id,
                  role: "assistant",
                  content: fullAnswer,
                },
              });
              controller.enqueue(encoder.encode(`event: messageId\ndata: ${JSON.stringify({ messageId: assistantMsg.id })}\n\n`));

              // message.received webhook for the assistant reply (opt-in, fire-and-forget).
              if (project.webhookUrl && webhookEventEnabled(settings, "message.received")) {
                sendWebhook(
                  project.webhookUrl,
                  "message.received",
                  { id: project.id, name: project.name },
                  { session: { id: session.id }, message: { id: assistantMsg.id, role: "assistant", content: fullAnswer, createdAt: assistantMsg.createdAt.toISOString() } }
                ).catch((e) => console.warn("[Webhook] message.received (assistant) failed:", e));
              }

              await prisma.usageRecord.create({
                data: {
                  userId: project.userId,
                  type: "chat_message",
                  amount: 1,
                },
              });
            } catch (saveError) {
              console.error("[Chat] Error saving assistant response:", saveError);
            }
          }
        } catch (streamError) {
          console.error("[Chat] error in ReadableStream execution:", streamError);
          const msg = streamError instanceof Error ? streamError.message : "Internal streaming error";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: `[ERROR] ${msg}` })}\n\n`));
        } finally {
          console.log(`[Chat] Closing stream for project: ${projectId}`);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
      status: 200,
    });
  } catch (fatalError) {
    console.error("[Chat Action] Fatal Error:", fatalError);
    captureException(fatalError, { where: "api.chat.action" });
    return json({ 
      error: "Internal Server Error", 
      details: fatalError instanceof Error ? fatalError.message : String(fatalError) 
    }, { status: 500 });
  }
}
