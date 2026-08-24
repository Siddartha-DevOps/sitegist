import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data",
]);

function blockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 88 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function ipv6Words(address: string): number[] | null {
  let source = address;
  const dottedTail = source.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const octets = dottedTail.split(".").map(Number);
    source = source.slice(0, -dottedTail.length) + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => Number.parseInt(word || "0", 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null;
}

export function isPrivateOrReservedIp(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (isIP(address) === 4) return blockedIpv4(address);
  if (isIP(address) !== 6) return true;
  const words = ipv6Words(address);
  if (!words) return true;
  const [first, second] = words;
  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (ipv4Mapped) {
    return blockedIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  if (words.slice(0, 6).every((word) => word === 0)) return true; // unspecified, loopback, IPv4-compatible
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true;
  if (first === 0x2001 && second === 0x0db8) return true; // documentation range
  return (first & 0xe000) !== 0x2000; // allow globally routed 2000::/3 only
}

export async function assertSafeOutboundUrl(input: string | URL): Promise<URL> {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are allowed");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Private or local network URLs are not allowed");
  }

  if (isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) throw new Error("Private or reserved IP addresses are not allowed");
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new Error("URL resolves to a private or reserved network address");
  }
  return url;
}

export async function safeOutboundFetch(
  input: string | URL,
  init: RequestInit = {},
  maxRedirects = 5
): Promise<Response> {
  let current = await assertSafeOutboundUrl(input);
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirect === maxRedirects) throw new Error("Too many redirects");
    await response.body?.cancel();
    current = await assertSafeOutboundUrl(new URL(location, current));
  }
  throw new Error("Too many redirects");
}

export async function readTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
