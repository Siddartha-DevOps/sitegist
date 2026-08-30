/**
 * Unit tests for Paddle Live webhook IP allowlisting helpers.
 */
import { describe, expect, it } from "vitest";
import { extractRequestIpv4 } from "./paddle-webhook-ips.server";

describe("extractRequestIpv4", () => {
  it("reads the first x-forwarded-for hop", () => {
    const req = new Request("https://example.com/api/webhook", {
      headers: { "x-forwarded-for": "34.237.3.244, 10.0.0.1" },
    });
    expect(extractRequestIpv4(req)).toBe("34.237.3.244");
  });

  it("falls back to x-real-ip", () => {
    const req = new Request("https://example.com/api/webhook", {
      headers: { "x-real-ip": "34.195.105.136" },
    });
    expect(extractRequestIpv4(req)).toBe("34.195.105.136");
  });

  it("returns null when missing", () => {
    const req = new Request("https://example.com/api/webhook");
    expect(extractRequestIpv4(req)).toBeNull();
  });
});
