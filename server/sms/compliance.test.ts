import { describe, expect, it } from "vitest";
import { consentAllowsSend, smsKeyword } from "./consent";
import { validateApprovedSmsMessage, validateSmsLinks, classifySmsForPolicy } from "./policy";
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
  it("does not trust transactional model classification for unmistakably promotional offers", () => {
    expect(classifySmsForPolicy("Get 25% off whitening this weekend", "TRANSACTIONAL")).toBe("MARKETING");
    expect(classifySmsForPolicy("Your appointment is Friday. Use your booking link.", "TRANSACTIONAL")).toBe("TRANSACTIONAL");
    expect(classifySmsForPolicy("We cannot confirm this message", "UNCERTAIN")).toBe("UNCERTAIN");
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
  it("accepts genuine booking destinations but blocks public shorteners, local and insecure links", () => {
    expect(() => validateSmsLinks("Your appointment https://book.example.com/abc?a=1", true)).not.toThrow();
    expect(() => validateSmsLinks("Visit https://bit.ly/abc", true)).toThrow(/trusted HTTPS link/);
    expect(() => validateSmsLinks("Visit http://example.com", true)).toThrow();
    expect(() => validateSmsLinks("Visit https://127.0.0.1/private", true)).toThrow();
    expect(() => validateSmsLinks("Visit www.example.com/appointment", true)).not.toThrow();
  });
  it("honors exact opt-out instructions without guessing from normal replies", () => {
    expect(smsKeyword("stop.")).toBe("STOP");
    expect(smsKeyword("UNSTOP")).toBe("START");
    expect(smsKeyword("HELP")).toBe("HELP");
    expect(smsKeyword("Stop texting me")).toBe("STOP");
    expect(smsKeyword("Please don't text me anymore")).toBe("STOP");
    expect(smsKeyword("No more messages")).toBe("STOP");
    expect(smsKeyword("stop by tomorrow")).toBe(null);
  });
});
