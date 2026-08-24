import type { Party, PartyServer, PartyConnection, PartyRequest, PartyLobby, PartyWorker } from "partykit/server";
import { verifyRealtimeToken } from "../app/lib/realtime-auth";

export default class ChatServer implements PartyServer {
  constructor(readonly party: Party) {}

  static async onBeforeConnect(request: PartyRequest, lobby: PartyLobby) {
    const secret = String(lobby.env.PARTYKIT_AUTH_SECRET || "");
    const token = new URL(request.url).searchParams.get("token");
    const claims = await verifyRealtimeToken(token, lobby.id, secret, ["visitor", "agent"]);
    return claims ? request : new Response("Unauthorized", { status: 401 });
  }

  onConnect(connection: PartyConnection) {
    // Welcome the new connection
    console.log(`Connected: ${connection.id}`);
  }

  onMessage(_message: string, sender: PartyConnection) {
    // Clients are read-only listeners. All broadcasts must pass through an
    // authenticated application endpoint that persists/authorizes the event.
    sender.close(1008, "Client broadcasts are not allowed");
  }

  onClose(connection: PartyConnection) {
    console.log(`Closed: ${connection.id}`);
  }

  async onRequest(request: PartyRequest) {
    if (request.method === "POST") {
      const secret = String(this.party.env.PARTYKIT_AUTH_SECRET || "");
      const authorization = request.headers.get("authorization") || "";
      const token = authorization.replace(/^Bearer\s+/i, "").trim();
      const claims = await verifyRealtimeToken(token, this.party.id, secret, ["server"]);
      if (!claims) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      try {
        const body = await request.json();
        this.party.broadcast(JSON.stringify(body));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }
    }
    // Basic health check or metadata endpoint
    return new Response("PartyKit Chat Server is running!");
  }
}

ChatServer satisfies PartyWorker;
