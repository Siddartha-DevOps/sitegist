import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/database/db.server";
import { sendWebhook, webhookEventEnabled } from "~/lib/webhook.server";
import { requireProjectAccess } from "~/lib/project-access.server";
import { broadcastRealtime } from "~/lib/partykit.server";

export async function action({ request }: ActionFunctionArgs) {
  console.log(`[Resolve Session API] Action triggered`);
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { sessionId } = await request.json();

    if (!sessionId) {
      return json({ error: "Missing required fields (sessionId)" }, { status: 400 });
    }

    const isDemo = sessionId === "demo-session";

    if (!isDemo) {
      // Validate that this conversation belongs to the user's project
      const session = await prisma.chatSession.findUnique({
        where: { id: sessionId },
        include: {
          project: true,
        },
      });

      if (!session) {
        return json({ error: "Conversation not found or unauthorized" }, { status: 404 });
      }
      await requireProjectAccess(request, session.projectId, { minRole: "ADMIN" });

      // Update session: mode: 'ai', status: 'resolved'
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: {
          mode: "ai",
          status: "resolved",
          updatedAt: new Date(),
        },
      });

      if (session.project.webhookUrl && webhookEventEnabled((session.project.settings as any), 'conversation.resolved')) {
        await sendWebhook(session.project.webhookUrl, 'conversation.resolved', {
          id: session.project.id,
          name: session.project.name,
        }, {
          session: { id: sessionId, resolvedAt: new Date().toISOString() },
        });
      }
    }

    // Broadcast resolved event via PartyKit
    await broadcastRealtime(sessionId, { type: "resolved", sessionId })
      .catch((partyErr) => console.error("[Resolve Session API] Error broadcasting to PartyKit:", partyErr));

    return json({ ok: true });
  } catch (err: any) {
    console.error("[Resolve Session API] Fatal error:", err);
    return json({ error: err.message || "Internal server error" }, { status: 500 });
  }
}
