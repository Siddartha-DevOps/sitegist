export type RealtimeRole = "visitor" | "agent" | "server";

export type RealtimeClaims = {
  roomId: string;
  role: RealtimeRole;
  exp: number;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function keyFor(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createRealtimeToken(
  roomId: string,
  role: RealtimeRole,
  secret: string,
  ttlSeconds = 60 * 60
): Promise<string> {
  const claims: RealtimeClaims = { roomId, role, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await keyFor(secret), new TextEncoder().encode(payload));
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyRealtimeToken(
  token: string | null | undefined,
  roomId: string,
  secret: string,
  allowedRoles: RealtimeRole[]
): Promise<RealtimeClaims | null> {
  if (!token || !secret) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await keyFor(secret),
      base64UrlToBytes(signature),
      new TextEncoder().encode(payload)
    );
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as RealtimeClaims;
    if (claims.roomId !== roomId || claims.exp <= Math.floor(Date.now() / 1000) || !allowedRoles.includes(claims.role)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
