import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/database/db.server";
import { sendEmail } from "~/lib/email.server";
import { sendWebhook, webhookEventEnabled } from "~/lib/webhook.server";
import { notifySlackEscalation } from "~/lib/slack.server";
import { pickAgentEmail } from "~/backend/routing.server";
import { verifyWidgetSessionToken } from "~/lib/widget-session.server";
import { enforcePublicRateLimit } from "~/lib/public-rate-limit.server";
import { broadcastRealtime } from "~/lib/partykit.server";

export async function action({ request }: ActionFunctionArgs) {
  console.log(`[Escalation API] Action triggered`);
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { sessionId, projectId, sessionToken } = await request.json();

    if (
      typeof sessionId !== "string" || !sessionId || sessionId.length > 200 ||
      typeof projectId !== "string" || !projectId || projectId.length > 200
    ) {
      return json({ error: "Missing required fields" }, { status: 400 });
    }

    console.log(`[Escalation API] Processing sessionId: ${sessionId}, projectId: ${projectId}`);

    const isDemo = projectId === "demo-project" && sessionId === "demo-session";

    if (!isDemo) {
      const proofSession = await prisma.chatSession.findFirst({
        where: { id: sessionId, projectId },
        select: { id: true },
      });
      if (!proofSession || !verifyWidgetSessionToken(sessionToken, sessionId, projectId)) {
        return json({ error: "Invalid widget session" }, { status: 401 });
      }

      const limit = await enforcePublicRateLimit(request, `escalate:${projectId}`, 5, 3600);
      if (!limit.allowed) {
        return json({ error: "Too many escalation requests" }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
      }

      // Atomically claim the transition. Retries and concurrent requests must
      // not send duplicate email, Slack, webhook, CRM, or help-desk actions.
      const transition = await prisma.chatSession.updateMany({
        where: { id: sessionId, projectId, mode: { not: "human" } },
        data: { mode: "human", isRead: false, updatedAt: new Date() },
      });
      if (transition.count === 0) return json({ ok: true, alreadyEscalated: true });

      // 2. Load project + owner user
      try {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          include: { user: true },
        });

        if (project) {
          // Agent routing: assign the escalated conversation per settings.
          let assignedTo: string | null = null;
          try {
            const routingMode = ((project.settings as any)?.escalation?.routing?.mode) || "off";
            assignedTo = await pickAgentEmail(projectId, routingMode);
            if (assignedTo) {
              await prisma.chatSession.update({ where: { id: sessionId }, data: { assignedTo } });
            }
          } catch (routeErr) {
            console.error("[Escalation API] Agent routing failed:", routeErr);
          }

          // 3. Send email to owner
          const ownerEmail = project.user.email;
          await sendEmail({
            to: ownerEmail,
            subject: `[SiteGist] Human handoff requested — ${project.name}`,
            html: `<p>A visitor on <strong>${project.name}</strong> requested a live agent.</p>
                   <p><a href="https://app.sitegist.co/dashboard/inbox/${sessionId}">Open conversation →</a></p>`,
          }).catch((emailErr) => {
            console.error("[Escalation API] Error sending email notification:", emailErr);
          });

          // 4. Fire project.webhookUrl if set (same pattern as existing handoff webhook)
          if (project.webhookUrl && webhookEventEnabled((project.settings as any), 'conversation.escalated')) {
            console.log(`[Escalation API] Triggering webhook for project: ${project.name}`);
            await sendWebhook(project.webhookUrl, 'conversation.escalated', {
              id: project.id,
              name: project.name,
            }, {
              session: { id: sessionId },
              trigger: 'visitor_requested',
              ...(assignedTo ? { assignedTo } : {}),
            });
          }

          const slackWebhookUrl = (project.settings as any)?.slackWebhookUrl;
          if (slackWebhookUrl) {
            let lastMessage: string | undefined;
            try {
              const lastMsgDoc = await prisma.message.findFirst({
                where: { sessionId },
                orderBy: { createdAt: "desc" },
                select: { content: true }
              });
              if (lastMsgDoc) {
                lastMessage = lastMsgDoc.content;
              }
            } catch (dbErr) {
              console.error("[Escalation API] DB error fetching last message for Slack preview:", dbErr);
            }

            await notifySlackEscalation(slackWebhookUrl, {
              projectName: project.name,
              projectId: project.id,
              sessionId,
              trigger: 'visitor_requested',
              previewMessage: lastMessage,
            }).catch((err) => {
              console.error("[Escalation API] Slack notification failed:", err);
            });
          }

          // --- Help Desk Integrations ---
          const intercomIntegration = await prisma.integration.findUnique({
            where: { projectId_provider: { projectId, provider: "intercom" } },
          });
          const freshdeskIntegration = await prisma.integration.findUnique({
            where: { projectId_provider: { projectId, provider: "freshdesk" } },
          });
          const zohoIntegration = await prisma.integration.findUnique({
            where: { projectId_provider: { projectId, provider: "zoho" } },
          });
          const zendeskIntegration = await prisma.integration.findUnique({
            where: { projectId_provider: { projectId, provider: "zendesk" } },
          });

          if (intercomIntegration || freshdeskIntegration || zohoIntegration || zendeskIntegration) {
            // Load chat transcript
            const messages = await prisma.message.findMany({
              where: { sessionId },
              orderBy: { createdAt: "asc" },
              take: 20,
            });

            const transcript = messages
              .map((m) => `${m.role === "user" ? "Visitor" : "Bot"}: ${m.content}`)
              .join("\n");

            const intercomTranscript = messages
              .map((m) => `**${m.role === "user" ? "Visitor" : "Bot"}:** ${m.content}`)
              .join("\n\n");

            const session = await prisma.chatSession.findUnique({
              where: { id: sessionId },
              select: { customerEmail: true },
            });

            // --- Intercom Handoff ---
            if (intercomIntegration) {
              try {
                const details = intercomIntegration.details as any;
                // Find or create an Intercom contact for the visitor
                let contactId: string | undefined;
                if (session?.customerEmail) {
                  try {
                    const contactRes = await fetch(
                      `https://api.intercom.io/contacts/search`,
                      {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${intercomIntegration.accessToken}`,
                          "Intercom-Version": "2.10",
                        },
                        body: JSON.stringify({
                          query: { field: "email", operator: "=", value: session.customerEmail },
                        }),
                      }
                    );
                    if (contactRes.ok) {
                      const contactData = await contactRes.json();
                      contactId = contactData.data?.[0]?.id;
                    }

                    if (!contactId) {
                      // Create contact if not found
                      const createRes = await fetch("https://api.intercom.io/contacts", {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${intercomIntegration.accessToken}`,
                          "Intercom-Version": "2.10",
                        },
                        body: JSON.stringify({ role: "lead", email: session.customerEmail }),
                      });
                      if (createRes.ok) {
                        const created = await createRes.json();
                        contactId = created.id;
                      }
                    }
                  } catch (contactErr) {
                    console.error("[Intercom Escalation] Failed searching/creating contact:", contactErr);
                  }
                }

                // Create a new Intercom conversation with the transcript as the first message
                await fetch("https://api.intercom.io/conversations", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${intercomIntegration.accessToken}`,
                    "Intercom-Version": "2.10",
                  },
                  body: JSON.stringify({
                    from: contactId
                      ? { type: "contact", id: contactId }
                      : { type: "admin", id: details?.bot_admin_id }, // fallback if no visitor email
                    body: `🤖 Chat escalated from ${project.name}\n\n${intercomTranscript}`,
                  }),
                }).catch((e) => console.error("[Intercom] Failed to create conversation:", e));
              } catch (intercomErr) {
                console.error("[Intercom Escalation] Error:", intercomErr);
              }
            }

            // --- Freshdesk Handoff ---
            if (freshdeskIntegration) {
              try {
                const { createFreshdeskTicket } = await import("~/lib/freshdesk.server");
                const htmlTranscript = messages
                  .map((m) => `<strong>${m.role === "user" ? "Visitor" : "Bot"}:</strong> ${m.content}`)
                  .join("<br>");

                await createFreshdeskTicket({
                  domain: (freshdeskIntegration.details as any).domain,
                  apiKey: freshdeskIntegration.accessToken,
                  subject: `Chat escalation — ${project.name}`,
                  description: `🤖 Chat escalated from ${project.name}<br><br>${htmlTranscript}`,
                  requesterEmail: session?.customerEmail || `noreply+${sessionId}@sitegist.co`,
                  tags: ["escalation"],
                });
              } catch (fdErr) {
                console.error("[Freshdesk Escalation] Failed creating ticket:", fdErr);
              }
            }

            // --- Zoho Handoff ---
            if (zohoIntegration) {
              try {
                const { createZohoTicket } = await import("~/lib/zoho.server");
                await createZohoTicket({
                  integration: zohoIntegration,
                  subject: `Chat escalation — ${project.name}`,
                  description: `🤖 Chat escalated from ${project.name}\n\n${transcript}`,
                  contactEmail: session?.customerEmail || undefined,
                });
              } catch (zohoErr) {
                console.error("[Zoho Escalation] Failed creating ticket:", zohoErr);
              }
            }

            // --- Zendesk Handoff ---
            if (zendeskIntegration) {
              try {
                const { createZendeskTicket } = await import("~/lib/zendesk.server");
                const details = zendeskIntegration.details as any;
                const htmlTranscript = messages
                  .map((m) => `<strong>${m.role === "user" ? "Visitor" : "Bot"}:</strong> ${m.content}`)
                  .join("<br>");

                await createZendeskTicket({
                  subdomain: details?.subdomain,
                  email: details?.email,
                  apiToken: zendeskIntegration.accessToken,
                  subject: `Chat escalation — ${project.name}`,
                  description: `🤖 Chat escalated from ${project.name}<br><br>${htmlTranscript}`,
                  requesterEmail: session?.customerEmail || undefined,
                  tags: ["escalation"],
                });
              } catch (zdErr) {
                console.error("[Zendesk Escalation] Failed creating ticket:", zdErr);
              }
            }
          }
        }
      } catch (projErr) {
        console.error("[Escalation API] DB error fetching project & user details:", projErr);
      }
    } else {
      const limit = await enforcePublicRateLimit(request, "escalate:demo", 5, 3600);
      if (!limit.allowed) return json({ error: "Too many escalation requests" }, { status: 429 });
    }

    // 5. Broadcast via PartyKit to room `sessionId` so the Inbox/widget updates live
    await broadcastRealtime(sessionId, { type: "escalated", sessionId, mode: "human" })
      .catch((partyErr) => console.error("[Escalation API] Error broadcasting to PartyKit:", partyErr));

    return json({ ok: true });
  } catch (err: any) {
    console.error("[Escalation API] Fatal error:", err);
    return json({ error: "Internal server error" }, { status: 500 });
  }
}
