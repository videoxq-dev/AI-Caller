import { describe, expect, it } from "vitest";
import { communicationSetupSchema } from "./schemas";

function validCommunicationSetup() {
  return {
    voice: { mode: "HOSTED", provider: null, numberMode: "new", number: "+15550001111" },
    sms: { mode: "BYOP", provider: "telnyx", numberMode: "same", displayName: "Acme", replyWindow: "Always respond", afterHoursBehavior: "Auto-reply + collect details" },
    whatsapp: { mode: "BYOP", provider: "whatsapp", accountMode: "existing" },
    webchat: { enabled: true },
    completeStep: false,
  };
}

describe("communication setup provider validation", () => {
  it("accepts supported hosted/BYOP combinations and Meta WhatsApp", () => {
    expect(communicationSetupSchema.safeParse(validCommunicationSetup()).success).toBe(true);
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
