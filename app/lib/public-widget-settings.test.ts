import { describe, expect, it } from "vitest";
import { toPublicWidgetSettings } from "./public-widget-settings";

describe("public widget settings", () => {
  it("returns display settings without operational secrets", () => {
    const result = toPublicWidgetSettings({
      systemPrompt: "private",
      slackWebhookUrl: "https://hooks.slack.test/secret",
      allowedDomains: ["private.example"],
      branding: { assistantName: "Help", primaryColor: "#123456", internalFlag: true },
      leadFields: [{ id: "email", label: "Email" }],
    });
    expect(result.branding).toEqual({ assistantName: "Help", primaryColor: "#123456" });
    expect(result.leadFields).toHaveLength(1);
    expect(result).not.toHaveProperty("systemPrompt");
    expect(result).not.toHaveProperty("slackWebhookUrl");
    expect(result).not.toHaveProperty("allowedDomains");
  });
});
