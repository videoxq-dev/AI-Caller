import { describe, expect, it } from "vitest";
import { calendarSetupSchema, communicationSetupSchema } from "./schemas";

function validCommunicationSetup() {
  return {
    voice: { mode: "BYOP", provider: "telnyx", numberMode: "existing", number: "+15550001111" },
    sms: { mode: "BYOP", provider: "telnyx", numberMode: "same", displayName: "Acme", replyWindow: "Always respond", afterHoursBehavior: "Auto-reply + collect details" },
    whatsapp: { mode: "BYOP", provider: "whatsapp", accountMode: "existing" },
    webchat: { enabled: true },
    completeStep: false,
  };
}

function validCalendarSetup() {
  return {
    provider: "google",
    meetingDurationMinutes: 30,
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 15,
    availableDays: ["Mon", "Tue"],
    startTime: "09:00",
    endTime: "17:00",
    timezone: "America/New_York",
    suggestAlternatives: true,
    eventType: "Consultation",
    meetingLocation: "Use provider default",
    maxBookingsPerDay: 8,
    completeStep: false,
  };
}

describe("communication setup provider validation", () => {
  it("accepts Telnyx BYOP voice, supported SMS routing, and Meta WhatsApp", () => {
    expect(communicationSetupSchema.safeParse(validCommunicationSetup()).success).toBe(true);
  });

  it("rejects hosted or non-Telnyx voice until those adapters are implemented", () => {
    const base = validCommunicationSetup();
    expect(communicationSetupSchema.safeParse({ ...base, voice: { ...base.voice, mode: "HOSTED", provider: null } }).success).toBe(false);
    expect(communicationSetupSchema.safeParse({ ...base, voice: { ...base.voice, provider: "twilio" } }).success).toBe(false);
  });

  it("rejects non-communication providers for voice and SMS", () => {
    const base = validCommunicationSetup();
    const input = { ...base, voice: { ...base.voice, mode: "BYOP", provider: "openai" } };
    expect(communicationSetupSchema.safeParse(input).success).toBe(false);
  });

  it("rejects hosted WhatsApp so setup cannot persist an unroutable state", () => {
    const base = validCommunicationSetup();
    const input = { ...base, whatsapp: { ...base.whatsapp, mode: "HOSTED", provider: null } };
    const result = communicationSetupSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path.join(".") === "whatsapp.provider")).toBe(true);
  });
});

describe("calendar setup validation", () => {
  it("accepts valid scheduling boundaries", () => {
    expect(calendarSetupSchema.safeParse(validCalendarSetup()).success).toBe(true);
  });

  it("requires at least one available day and a forward time window", () => {
    const result = calendarSetupSchema.safeParse({ ...validCalendarSetup(), availableDays: [], startTime: "17:00", endTime: "09:00" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "availableDays")).toBe(true);
      expect(result.error.issues.some((issue) => issue.path.join(".") === "endTime")).toBe(true);
    }
  });

  it("rejects malformed times and invalid IANA timezones", () => {
    expect(calendarSetupSchema.safeParse({ ...validCalendarSetup(), startTime: "9am" }).success).toBe(false);
    expect(calendarSetupSchema.safeParse({ ...validCalendarSetup(), timezone: "Not/AZone" }).success).toBe(false);
  });
});
