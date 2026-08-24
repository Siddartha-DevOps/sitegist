import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { generateSimpleAIStream } from "~/ai-layer/ai.server";
import { verifyTurnstile } from "~/backend/security.server";
import { enforcePublicRateLimit } from "~/lib/public-rate-limit.server";

const MAX_PROMPT_CHARS = 6_000;

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Invalid JSON body" }, { status: 400 });
    const { prompt, turnstileToken } = body;

    if (typeof prompt !== "string" || !prompt.trim()) {
      return json({ error: "Missing prompt" }, { status: 400 });
    }
    if (prompt.length > MAX_PROMPT_CHARS) return json({ error: "Prompt is too long" }, { status: 413 });
    const limit = await enforcePublicRateLimit(request, "tools-generate", 10, 3600);
    if (!limit.allowed) {
      return json({ error: "Generation limit reached" }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
    }
    if (typeof turnstileToken !== "string" || !(await verifyTurnstile(turnstileToken))) {
      return json({ error: "Security check failed" }, { status: 403 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const aiStream = generateSimpleAIStream(prompt);
          for await (const chunk of aiStream) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`));
          }
        } catch (err) {
          console.error("[Tools API] Stream Error:", err);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: "[ERROR] Stream failed" })}\n\n`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (error) {
    console.error("[Tools API] Fatal Error:", error);
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
