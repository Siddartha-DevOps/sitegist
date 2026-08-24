import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { requireUserId } from "~/backend/auth.server";
import { prisma } from "~/database/db.server";
import { requireProjectAccess } from "~/lib/project-access.server";
import { broadcastRealtime } from "~/lib/partykit.server";

export async function action({ request }: ActionFunctionArgs) {
  console.log(`[Agent Reply API] Action triggered`);
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // Require logged in user for dashboard authentication
  const userId = await requireUserId(request);

  try {
    const { sessionId, content } = await request.json();

    if (!sessionId || !content) {
      return json({ error: "Missing required fields (sessionId, content)" }, { status: 400 });
    }

    console.log(`[Agent Reply API] User: ${userId}, Session: ${sessionId}`);

    const isDemo = sessionId === "demo-session";

    if (!isDemo) {
      // Validate that this conversation belongs to the user's project
      const session = await prisma.chatSession.findUnique({ where: { id: sessionId }, select: { id: true, projectId: true } });

      if (!session) {
        return json({ error: "Conversation not found or unauthorized" }, { status: 404 });
      }
      await requireProjectAccess(request, session.projectId, { minRole: "ADMIN" });

      // Create Message
      await prisma.message.create({
        data: {
          sessionId,
          role: "assistant",
          content,
        },
      });

      // Update Session updatedAt
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: {
          updatedAt: new Date(),
        },
      });
    }

    // Broadcast helper via PartyKit
    await broadcastRealtime(sessionId, { type: "message", role: "assistant", content })
      .catch((partyErr) => console.error("[Agent Reply API] Error broadcasting to PartyKit:", partyErr));

    return json({ ok: true });
  } catch (err: any) {
    console.error("[Agent Reply API] Fatal error:", err);
    return json({ error: err.message || "Internal server error" }, { status: 500 });
  }
}
