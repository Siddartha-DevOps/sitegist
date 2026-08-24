import { describe, expect, it } from "vitest";
import { createWidgetSessionToken, verifyWidgetSessionToken } from "./widget-session.server";

describe("widget session tokens", () => {
  const secret = "test-secret";

  it("binds a token to one session and project", () => {
    const token = createWidgetSessionToken("session-1", "project-1", { secret, now: 100, ttlSeconds: 60 });
    expect(verifyWidgetSessionToken(token, "session-1", "project-1", { secret, now: 120 })).toBe(true);
    expect(verifyWidgetSessionToken(token, "session-2", "project-1", { secret, now: 120 })).toBe(false);
    expect(verifyWidgetSessionToken(token, "session-1", "project-2", { secret, now: 120 })).toBe(false);
  });

  it("rejects expired and tampered tokens", () => {
    const token = createWidgetSessionToken("session-1", "project-1", { secret, now: 100, ttlSeconds: 10 });
    expect(verifyWidgetSessionToken(token, "session-1", "project-1", { secret, now: 111 })).toBe(false);
    expect(verifyWidgetSessionToken(`${token}x`, "session-1", "project-1", { secret, now: 101 })).toBe(false);
  });
});
