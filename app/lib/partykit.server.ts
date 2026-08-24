import { createRealtimeToken } from "./realtime-auth";

export async function createRealtimeClientToken(roomId: string, role: "visitor" | "agent") {
  const secret = process.env.PARTYKIT_AUTH_SECRET?.trim();
  if (!secret) return null;
  return createRealtimeToken(roomId, role, secret);
}

export async function broadcastRealtime(roomId: string, payload: unknown): Promise<boolean> {
  const host = process.env.PARTYKIT_HOST?.trim();
  const secret = process.env.PARTYKIT_AUTH_SECRET?.trim();
  if (!host || !secret) {
    console.warn("[PartyKit] PARTYKIT_HOST/PARTYKIT_AUTH_SECRET missing; realtime broadcast skipped.");
    return false;
  }

  const cleanHost = host.replace(/\/$/, "");
  const roomUrl = `${cleanHost.startsWith("http") ? "" : "https://"}${cleanHost}/parties/main/${encodeURIComponent(roomId)}`;
  const token = await createRealtimeToken(roomId, "server", secret, 60);
  const response = await fetch(roomUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`PartyKit broadcast failed (${response.status})`);
  return true;
}
