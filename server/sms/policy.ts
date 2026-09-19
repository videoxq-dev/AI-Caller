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
