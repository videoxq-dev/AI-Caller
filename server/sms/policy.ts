import { AppError } from "@/server/http/errors";
export type SmsPurpose = "TRANSACTIONAL" | "MARKETING";
export type ApprovedSmsPolicy = {
  categories: SmsPurpose[];
  allowEmbeddedLinks: boolean;
  description: string;
};
export function validateApprovedSmsMessage(input: {
  policy: ApprovedSmsPolicy;
  classifiedPurpose: SmsPurpose | "UNCERTAIN";
  text: string;
}) {
  if (input.classifiedPurpose === "UNCERTAIN") throw new AppError("SMS_CAMPAIGN_REVIEW_REQUIRED", "Please edit this message: its purpose could not be confirmed.", 409);
  if (!input.policy.categories.includes(input.classifiedPurpose)) throw new AppError("SMS_CAMPAIGN_PURPOSE_NOT_APPROVED", "This message is outside your approved SMS campaign.", 409);
  if (!input.policy.allowEmbeddedLinks && /https?:\/\/|www\./i.test(input.text)) throw new AppError("SMS_CAMPAIGN_LINKS_NOT_APPROVED", "Embedded links are not approved for your SMS campaign.", 409);
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
