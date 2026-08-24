import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/database/db.server";
import { verifyWidgetSessionToken } from "~/lib/widget-session.server";
import { enforcePublicRateLimit } from "~/lib/public-rate-limit.server";

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.json().catch(() => null);
  const { messageId, sessionId, sessionToken, feedback } = body || {};

  if (!messageId || !sessionId || (feedback !== 1 && feedback !== -1)) {
    return json({ error: "Invalid feedback data" }, { status: 400 });
  }

  const session = await prisma.chatSession.findUnique({ where: { id: sessionId }, select: { projectId: true } });
  if (!session || !verifyWidgetSessionToken(sessionToken, sessionId, session.projectId)) {
    return json({ error: "Invalid session" }, { status: 401 });
  }
  const limit = await enforcePublicRateLimit(request, `feedback:${session.projectId}`, 60, 3600);
  if (!limit.allowed) return json({ error: "Too many requests" }, { status: 429 });

  try {
    // Scope the update to the visitor's own session: this is an unauthenticated
    // public endpoint, so without the sessionId constraint anyone could flip the
    // feedback on any message by guessing/enumerating ids (analytics poisoning).
    const res = await prisma.message.updateMany({
      where: { id: messageId, sessionId },
      data: { feedback }
    });

    if (res.count === 0) {
      return json({ error: "Message not found for this session" }, { status: 404 });
    }
    return json({ success: true, messageId });
  } catch (error) {
    return json({ error: "Failed to save feedback" }, { status: 500 });
  }
}
