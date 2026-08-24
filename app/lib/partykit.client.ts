import PartySocket from "partysocket";

/**
 * PartySocket utility for real-time multiplayer chat/collaboration.
 * This connects to a PartyKit server (which you deploy separately).
 */
export function createChatSocket(roomId: string, token?: string | null) {
  const host = (window as any).ENV?.PARTYKIT_HOST;
  
  if (!host || !token) {
    if (!host) console.error("PARTYKIT_HOST is not defined.");
    return null;
  }

  return new PartySocket({
    host,
    room: roomId,
    query: { token },
  });
}
