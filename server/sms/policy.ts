import { AppError } from "@/server/http/errors";
export type SmsPurpose = "TRANSACTIONAL" | "MARKETING";
export type ApprovedSmsPolicy = {
  categories: SmsPurpose[];
  allowEmbeddedLinks: boolean;
  description: string;
};
const SHORTENER_DOMAINS = new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "rebrand.ly", "shorturl.at"]);
export function validateSmsLinks(text: string, linksAllowed: boolean) {
  const links = text.match(/(?:https?:\/\/|www\.)[^\s<>]+/gi) ?? [];
  if (links.length && !linksAllowed) {
    throw new AppError("SMS_CAMPAIGN_LINKS_NOT_APPROVED", "Embedded links are not approved for your SMS campaign.", 409);
  }
  for (const rawLink of links) {
    const value = rawLink.replace(/[.,;!?]+$/, "");
    let link: URL;
    try { link = new URL(value.startsWith("www.") ? "https://" + value : value); }
    catch { throw new AppError("SMS_UNSAFE_LINK", "The SMS contains an invalid web address.", 409); }
    const host = link.hostname.toLowerCase().replace(/\.$/, "");
    const digits = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    const internal = digits && (Number(digits[1]) === 10 || Number(digits[1]) === 127 ||
      Number(digits[1]) === 0 || Number(digits[1]) === 192 && Number(digits[2]) === 168 ||
      Number(digits[1]) === 172 && Number(digits[2]) >= 16 && Number(digits[2]) <= 31);
    if (link.protocol !== "https:" || link.username || link.password ||
        !host.includes(".") || host === "localhost" || host.endsWith(".local") ||
        SHORTENER_DOMAINS.has(host) || internal) {
      throw new AppError("SMS_UNSAFE_LINK", "Use a trusted HTTPS link rather than a shortened, local or insecure destination.", 409);
    }
  }
}

// High-confidence promotions override a model's transactional guess. Keep this narrow:
// appointment/booking vocabulary by itself is never a marketing signal.
export function classifySmsForPolicy(
  message: string,
  modelPurpose: SmsPurpose | "UNCERTAIN",
): SmsPurpose | "UNCERTAIN" {
  const promotionalOffer = /\b\d{1,3}\s*%\s*off\b|\b(?:get|save|enjoy|claim|unlock|receive)\b.{0,35}\b(?:discount|offer|deal)\b|\b\d{1,3}\s*%\s*discount\b|\b(?:special|limited[\s-]*time|exclusive)\s+(?:offer|deal|promotion)\b|\bpromo(?:tional)?\s+code\b|\b(?:use|apply)\s+code\s+[A-Z0-9]{3,}\b/i;
  return promotionalOffer.test(message) ? "MARKETING" : modelPurpose;
}

export function validateApprovedSmsMessage(input: {
  policy: ApprovedSmsPolicy;
  classifiedPurpose: SmsPurpose | "UNCERTAIN";
  text: string;
}) {
  if (input.classifiedPurpose === "UNCERTAIN") throw new AppError("SMS_CAMPAIGN_REVIEW_REQUIRED", "Please edit this message: its purpose could not be confirmed.", 409);
  if (!input.policy.categories.includes(input.classifiedPurpose)) throw new AppError("SMS_CAMPAIGN_PURPOSE_NOT_APPROVED", "This message is outside your approved SMS campaign.", 409);
  validateSmsLinks(input.text, input.policy.allowEmbeddedLinks);
  return input.classifiedPurpose;
}

export type CarrierStatus = "PENDING" | "READY" | "REJECTED";
export function tollFreeCarrierStatus(status: string | null | undefined): CarrierStatus {
  if (status === "Verified") return "READY";
  if (status === "Rejected") return "REJECTED";
  return "PENDING";
}
export function tenDlcCarrierStatus(input: {
  brandStatus?: string | null; identityStatus?: string | null;
  submissionStatus?: string | null; campaignStatus?: string | null;
  assignmentStatus?: string | null;
}): CarrierStatus {
  if (input.brandStatus === "REGISTRATION_FAILED" || input.submissionStatus === "FAILED" ||
      ["TCR_FAILED", "TELNYX_FAILED", "MNO_REJECTED", "MNO_PROVISIONING_FAILED", "TCR_SUSPENDED", "TCR_EXPIRED"].includes(input.campaignStatus ?? "") ||
      ["FAILED_ASSIGNMENT", "FAILED_UNASSIGNMENT", "PENDING_UNASSIGNMENT"].includes(input.assignmentStatus ?? "")) return "REJECTED";
  if (input.brandStatus === "OK" &&
      ["VERIFIED", "VETTED_VERIFIED"].includes(input.identityStatus ?? "") &&
      input.submissionStatus === "CREATED" && input.campaignStatus === "MNO_PROVISIONED" &&
      input.assignmentStatus === "ASSIGNED") return "READY";
  return "PENDING";
}
