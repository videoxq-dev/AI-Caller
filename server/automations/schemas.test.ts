import { describe, expect, it } from "vitest";
import { defaultAutomationConfig, parseAutomationConfig } from "./schemas";

describe("automation configuration", () => {
  it("defaults customer-message recipes to SMS-safe settings", () => {
    expect(defaultAutomationConfig("APPOINTMENT_REMINDER")).toMatchObject({
      channels: ["SMS"],
      firstMinutesBefore: 1440,
      secondMinutesBefore: 120,
    });
  });

  it("requires an approved WhatsApp template when automated WhatsApp delivery is enabled", () => {
    expect(() => parseAutomationConfig("APPOINTMENT_REMINDER", {
      channels: ["WHATSAPP"],
      firstMinutesBefore: 1440,
      secondMinutesBefore: null,
      message: "Reminder {{name}}",
    })).toThrow(/WhatsApp template/);
  });

  it("rejects a second reminder that would run before the first reminder", () => {
    expect(() => parseAutomationConfig("APPOINTMENT_REMINDER", {
      channels: ["SMS"],
      firstMinutesBefore: 120,
      secondMinutesBefore: 180,
      message: "Reminder",
    })).toThrow(/closer/);
  });
});
