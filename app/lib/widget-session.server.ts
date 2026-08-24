import { createHmac, timingSafeEqual } from "node:crypto";

type WidgetSessionClaims = {
  sessionId: string;
  projectId: string;
  exp: number;
};

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

function tokenSecret(explicit?: string): string {
  const secret = explicit || process.env.WIDGET_SESSION_SECRET || process.env.SESSION_SECRET || "";
  if (!secret || secret === "DEFAULT_SESSION_SECRET" || secret === "DEFAULT_SECRET_CHANGE_ME") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("WIDGET_SESSION_SECRET or a strong SESSION_SECRET is required in production");
    }
    return "sitegist-development-widget-session-secret";
  }
  return secret;
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createWidgetSessionToken(
  sessionId: string,
  projectId: string,
  options: { secret?: string; ttlSeconds?: number; now?: number } = {}
): string {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const claims: WidgetSessionClaims = {
    sessionId,
    projectId,
    exp: now + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, tokenSecret(options.secret))}`;
}

export function verifyWidgetSessionToken(
  token: unknown,
  sessionId: string,
  projectId: string,
  options: { secret?: string; now?: number } = {}
): boolean {
  if (typeof token !== "string") return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;

  const expected = sign(payload, tokenSecret(options.secret));
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as WidgetSessionClaims;
    const now = options.now ?? Math.floor(Date.now() / 1000);
    return claims.sessionId === sessionId && claims.projectId === projectId && claims.exp > now;
  } catch {
    return false;
  }
}
