import { getRedis } from "./redis.server";

const memoryCounters = new Map<string, { count: number; expiresAt: number }>();
const MAX_MEMORY_COUNTERS = 10_000;

export function requestIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export async function enforcePublicRateLimit(
  request: Request,
  scope: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; retryAfter: number }> {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const retryAfter = Math.max(1, Math.ceil(((bucket + 1) * windowSeconds * 1000 - Date.now()) / 1000));
  const key = `public-limit:${scope}:${requestIp(request)}:${bucket}`;
  const redis = getRedis();
  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSeconds + 5);
      return { allowed: count <= limit, retryAfter };
    } catch (error) {
      console.warn("[Rate Limit] Redis unavailable; using per-instance fallback.", error);
    }
  }

  const now = Date.now();
  const current = memoryCounters.get(key);
  const next = !current || current.expiresAt <= now
    ? { count: 1, expiresAt: now + windowSeconds * 1000 }
    : { count: current.count + 1, expiresAt: current.expiresAt };
  memoryCounters.set(key, next);
  if (memoryCounters.size > MAX_MEMORY_COUNTERS) {
    for (const [candidate, value] of memoryCounters) if (value.expiresAt <= now) memoryCounters.delete(candidate);
    while (memoryCounters.size > MAX_MEMORY_COUNTERS) {
      const oldest = memoryCounters.keys().next().value;
      if (oldest === undefined) break;
      memoryCounters.delete(oldest);
    }
  }
  return { allowed: next.count <= limit, retryAfter: Math.max(1, Math.ceil((next.expiresAt - now) / 1000)) };
}
