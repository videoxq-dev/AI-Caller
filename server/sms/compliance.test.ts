import { describe, expect, it } from "vitest";
import { consentAllowsSend, smsKeyword } from "./consent";
import { validateApprovedSmsMessage } from "./policy";
import { parseSmsClassification } from "./classification";

describe("outbound SMS compliance", () => {
  const policy = { categories: ["TRANSACTIONAL" as const], allowEmbeddedLinks: true, description: "Appointment updates" };
  it("keeps a single transactional opt-in valid for later appointment reminders", () => {
    expect(consentAllowsSend({ consent: "OPTED_IN", purpose: "TRANSACTIONAL", currentConversationReply: false })).toBe(true);
    expect(consentAllowsSend({ consent: "UNKNOWN", purpose: "TRANSACTIONAL", currentConversationReply: true })).toBe(true);
    expect(consentAllowsSend({ consent: "UNKNOWN", purpose: "TRANSACTIONAL", currentConversationReply: false })).toBe(false);
  });
  it("requires separate marketing consent and respects revocations", () => {
    expect(consentAllowsSend({ consent: "UNKNOWN", purpose: "MARKETING", currentConversationReply: true })).toBe(false);
    expect(consentAllowsSend({ consent: "OPTED_OUT", purpose: "TRANSACTIONAL", currentConversationReply: true })).toBe(false);
  });
  it("allows contextual booking links but rejects campaign-incompatible promotion", () => {
    expect(validateApprovedSmsMessage({ policy, classifiedPurpose: "TRANSACTIONAL", text: "Your booking: https://clinic.com/a" })).toBe("TRANSACTIONAL");
    expect(() => validateApprovedSmsMessage({ policy, classifiedPurpose: "MARKETING", text: "25% off" })).toThrow();
    expect(() => validateApprovedSmsMessage({ policy: { ...policy, allowEmbeddedLinks: false }, classifiedPurpose: "TRANSACTIONAL", text: "https://clinic.com/a" })).toThrow();
  });
  it("does not trust invalid or uncertain model classifications", () => {
    expect(parseSmsClassification('{"purpose":"MARKETING"}')).toBe("MARKETING");
    expect(parseSmsClassification('{"purpose":"TRANSACTIONAL"}')).toBe("TRANSACTIONAL");
    expect(parseSmsClassification('{"purpose":"UNCERTAIN"}')).toBe("UNCERTAIN");
    expect(parseSmsClassification("not JSON")).toBe("UNCERTAIN");
  });
  it("honors exact opt-out instructions without guessing from normal replies", () => {
    expect(smsKeyword("stop.")).toBe("STOP");
    expect(smsKeyword("UNSTOP")).toBe("START");
    expect(smsKeyword("HELP")).toBe("HELP");
    expect(smsKeyword("stop by tomorrow")).toBe(null);
  });
});
