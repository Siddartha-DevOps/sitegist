/**
 * Allowlist Paddle Live webhook source IPs.
 * Source of truth: GET https://api.paddle.com/ips → data.ipv4_cidrs
 * (Do not hard-code — the list can change.)
 */

const LIVE_IPS_URL = "https://api.paddle.com/ips";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedCidrs: string[] | null = null;
let cachedAt = 0;

export async function getPaddleLiveWebhookCidrs(): Promise<string[]> {
  if (cachedCidrs && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedCidrs;
  }
  const res = await fetch(LIVE_IPS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Paddle IPs: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: { ipv4_cidrs?: string[] } };
  const cidrs = body?.data?.ipv4_cidrs;
  if (!Array.isArray(cidrs) || cidrs.length === 0) {
    throw new Error("Paddle /ips returned no ipv4_cidrs");
  }
  cachedCidrs = cidrs;
  cachedAt = Date.now();
  return cidrs;
}

/** Parse /32 (or any) CIDR to a single IPv4 string when mask is 32; else return null for non-/32. */
function cidrToExactIp(cidr: string): string | null {
  const [ip, mask] = cidr.split("/");
  if (!ip || mask === undefined) return null;
  if (mask === "32") return ip;
  // Broader CIDRs are uncommon for Paddle today; treat as no exact match helper.
  return null;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) + octet;
  }
  return n >>> 0;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [base, maskStr] = cidr.split("/");
  const maskBits = Number(maskStr);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base || "");
  if (ipInt === null || baseInt === null || !Number.isInteger(maskBits) || maskBits < 0 || maskBits > 32) {
    return false;
  }
  if (maskBits === 32) return ipInt === baseInt;
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export function extractRequestIpv4(request: Request): string | null {
  // Prefer the left-most public hop Paddle would hit on Vercel.
  const forwarded = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "";
  const candidate = forwarded.split(",")[0]?.trim() || "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(candidate)) return candidate;
  return null;
}

/**
 * Returns true if the request appears to come from a Paddle Live webhook IP.
 * When Paddle IPs cannot be fetched, fails closed unless PADDLE_WEBHOOK_SKIP_IP_CHECK=1
 * (emergency escape hatch only).
 */
export async function isPaddleLiveWebhookIp(request: Request): Promise<{
  ok: boolean;
  ip: string | null;
  reason?: string;
}> {
  if (process.env.PADDLE_WEBHOOK_SKIP_IP_CHECK?.trim() === "1") {
    return { ok: true, ip: extractRequestIpv4(request), reason: "skip_env" };
  }

  const ip = extractRequestIpv4(request);
  if (!ip) {
    return { ok: false, ip: null, reason: "missing_client_ip" };
  }

  let cidrs: string[];
  try {
    cidrs = await getPaddleLiveWebhookCidrs();
  } catch (e: any) {
    console.error("[Paddle webhook] IP allowlist fetch failed:", e?.message || e);
    return { ok: false, ip, reason: "ip_list_unavailable" };
  }

  const allowed = cidrs.some((c) => ipInCidr(ip, c) || cidrToExactIp(c) === ip);
  return allowed ? { ok: true, ip } : { ok: false, ip, reason: "ip_not_allowlisted" };
}
