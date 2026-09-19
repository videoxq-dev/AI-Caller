import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { hostedPhoneNumbers, smsRegistrations } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { ProviderRequestError } from "@/server/providers/http";
import { tenDlcCarrierStatus, tollFreeCarrierStatus, type ApprovedSmsPolicy } from "./policy";
import { telnyxRegistrationClient, type TelnyxRegistrationDraft } from "./registration-provider";

const BATCH_MAX = 50;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export function approvedPolicyFromDraft(draft: TelnyxRegistrationDraft): ApprovedSmsPolicy {
  return {
    categories: draft.categories,
    allowEmbeddedLinks: draft.allowEmbeddedLinks,
    description: draft.messagingUseCase,
  };
}

async function numberRegistration(workspaceId: string) {
  const [row] = await db.select({ number: hostedPhoneNumbers, registration: smsRegistrations })
    .from(hostedPhoneNumbers).innerJoin(smsRegistrations, and(
      eq(smsRegistrations.workspaceId, hostedPhoneNumbers.workspaceId),
      eq(smsRegistrations.phoneNumberId, hostedPhoneNumbers.id),
    )).where(and(
      eq(hostedPhoneNumbers.workspaceId, workspaceId),
      eq(hostedPhoneNumbers.status, "ACTIVE"),
      isNull(hostedPhoneNumbers.releasedAt),
    )).limit(1);
  if (!row) throw new AppError("SMS_REGISTRATION_DRAFT_REQUIRED", "Save a registration draft for your active phone number first.", 409);
  return row;
}

export async function submitSmsRegistration(workspaceId: string) {
  const { number, registration } = await numberRegistration(workspaceId);
  if (number.countryCode !== "US") throw new AppError("SMS_UNSUPPORTED_COUNTRY", "Only US managed numbers are supported.", 409);
  if (registration.status === "READY" || registration.status === "PENDING" || registration.status === "SUBMITTING") {
    return { status: registration.status };
  }
  if (registration.status !== "DRAFT" && registration.status !== "REJECTED") {
    throw new AppError("SMS_REGISTRATION_INVALID_STATE", "Registration cannot be submitted in its current state.", 409);
  }
  const [claimed] = await db.update(smsRegistrations).set({
    status: "SUBMITTING", carrierStatus: null, rejectionReason: null,
    approvedPolicy: null, updatedAt: new Date(),
  }).where(and(
    eq(smsRegistrations.workspaceId, workspaceId), eq(smsRegistrations.id, registration.id),
    inArray(smsRegistrations.status, ["DRAFT", "REJECTED"]),
  )).returning();
  if (!claimed) return { status: "SUBMITTING" as const };
  await db.update(hostedPhoneNumbers).set({ messagingReadiness: "PENDING", updatedAt: new Date() })
    .where(and(eq(hostedPhoneNumbers.workspaceId, workspaceId), eq(hostedPhoneNumbers.id, number.id)));
  try {
    await reconcileSmsRegistration(workspaceId, registration.id, { submitting: true });
  } catch (error) {
    logger.error({ err: error, workspaceId, registrationId: registration.id }, "SMS registration submission failed; readiness stays blocked");
    if (error instanceof ProviderRequestError && error.status >= 400 && error.status < 500) {
      await db.update(smsRegistrations).set({
        status: "REJECTED", carrierStatus: "SUBMISSION_REJECTED", rejectionReason: error.message.slice(0, 1000),
        updatedAt: new Date(),
      }).where(and(eq(smsRegistrations.workspaceId, workspaceId), eq(smsRegistrations.id, registration.id)));
      await db.update(hostedPhoneNumbers).set({ messagingReadiness: "REJECTED", updatedAt: new Date() })
        .where(and(eq(hostedPhoneNumbers.workspaceId, workspaceId), eq(hostedPhoneNumbers.id, number.id)));
      throw new AppError("SMS_REGISTRATION_REJECTED", "Telnyx rejected the submission. Correct the registration details and try again.", 409);
    }
    throw new AppError("SMS_REGISTRATION_SUBMISSION_UNCERTAIN", "Carrier submission may be processing. Do not resubmit; AI Caller will check the carrier status.", 503);
  }
  const [current] = await db.select({ status: smsRegistrations.status }).from(smsRegistrations)
    .where(and(eq(smsRegistrations.workspaceId, workspaceId), eq(smsRegistrations.id, registration.id))).limit(1);
  return { status: current?.status ?? "SUBMITTING" };
}

export async function reconcileSmsRegistration(
  workspaceId: string,
  registrationId: string,
  options: { submitting?: boolean } = {},
  client = telnyxRegistrationClient(),
) {
  const [row] = await db.select({ number: hostedPhoneNumbers, registration: smsRegistrations })
    .from(smsRegistrations).innerJoin(hostedPhoneNumbers, and(
      eq(hostedPhoneNumbers.id, smsRegistrations.phoneNumberId),
      eq(hostedPhoneNumbers.workspaceId, smsRegistrations.workspaceId),
    )).where(and(eq(smsRegistrations.workspaceId, workspaceId), eq(smsRegistrations.id, registrationId)))
    .limit(1);
  if (!row) throw new AppError("SMS_REGISTRATION_NOT_FOUND", "Registration not found.", 404);
  const { number, registration } = row;
  if (!["SUBMITTING", "PENDING", "READY"].includes(registration.status) || number.status !== "ACTIVE" || number.releasedAt) return registration.status;
  const draft = registration.draft as TelnyxRegistrationDraft;
  const resubmission = options.submitting === true && registration.submittedAt !== null;
  let carrierStatus = "";
  let reason: string | null = null;
  let status: "PENDING" | "READY" | "REJECTED" = "PENDING";
  let brandId = registration.carrierBrandId;
  let campaignId = registration.carrierCampaignId;
  let verificationId = registration.carrierVerificationId;
  const now = new Date();

  if (number.numberType === "toll_free") {
    if (!verificationId) {
      const existing = await client.findTollFreeByNumber(number.phoneNumber);
      verificationId = existing?.id ?? null;
      if (!verificationId && options.submitting) {
        const created = await client.createTollFree(draft, number.phoneNumber);
        verificationId = created.id ?? null;
      }
      if (!verificationId) return "SUBMITTING";
      await db.update(smsRegistrations).set({
        carrierVerificationId: verificationId, submittedAt: registration.submittedAt ?? now,
        updatedAt: now,
      }).where(and(eq(smsRegistrations.id, registration.id), eq(smsRegistrations.workspaceId, workspaceId)));
    }
    if (registration.carrierVerificationId && options.submitting) {
      await client.updateTollFree(verificationId, draft, number.phoneNumber);
    }
    const verified = await client.getTollFree(verificationId);
    const assigned = verified.phoneNumbers?.some((candidate) => candidate.phoneNumber === number.phoneNumber) ?? false;
    carrierStatus = verified.verificationStatus ?? "UNKNOWN";
    status = assigned ? tollFreeCarrierStatus(carrierStatus) : "PENDING";
    reason = verified.reason ?? (assigned ? null : "Carrier verification does not include this phone number.");
  } else if (number.numberType === "local") {
    if (!brandId && options.submitting) {
      const brand = await client.createBrand(draft);
      brandId = brand.brandId ?? null;
      if (!brandId) throw new Error("Telnyx did not return a brand ID. Carrier state requires investigation.");
      await db.update(smsRegistrations).set({
        carrierBrandId: brandId, submittedAt: registration.submittedAt ?? now,
      }).where(and(eq(smsRegistrations.id, registration.id), eq(smsRegistrations.workspaceId, workspaceId)));
    }
    if (!brandId) return "SUBMITTING";
    let brand = await client.getBrand(brandId);
    if (brand.status === "REGISTRATION_FAILED" && resubmission) {
      await client.updateBrand(brandId, draft);
      brand = await client.getBrand(brandId);
    }
    carrierStatus = brand.status ?? "UNKNOWN";
    reason = brand.failureReasons ?? null;
    if (brand.status === "REGISTRATION_FAILED") status = "REJECTED";
    else if (brand.status === "OK" && ["VERIFIED", "VETTED_VERIFIED"].includes(brand.identityStatus ?? "")) {
      if (!campaignId && (options.submitting || registration.carrierStatus !== "CAMPAIGN_SUBMITTING")) {
        // Persist the remote-create intent before making the potentially billable POST.
        // A timeout cannot safely be retried without a campaign ID: leave it blocked
        // and surface a carrier investigation instead of submitting duplicates.
        await db.update(smsRegistrations).set({
          carrierStatus: "CAMPAIGN_SUBMITTING", checkedAt: now, updatedAt: now,
        }).where(and(eq(smsRegistrations.id, registration.id), eq(smsRegistrations.workspaceId, workspaceId)));

        const campaign = await client.createCampaign(draft, brandId, registration.id);
        campaignId = campaign.campaignId ?? null;
        if (!campaignId) throw new Error("Telnyx did not return a campaign ID; do not resubmit.");
        await db.update(smsRegistrations).set({ carrierCampaignId: campaignId, updatedAt: now })
          .where(and(eq(smsRegistrations.id, registration.id), eq(smsRegistrations.workspaceId, workspaceId)));
      }
      if (!campaignId && registration.carrierStatus === "CAMPAIGN_SUBMITTING") {
        carrierStatus = "CAMPAIGN_SUBMISSION_UNCERTAIN";
        reason = "The last carrier campaign submission could not be confirmed. Contact support rather than resubmitting.";
      }
      if (campaignId) {
        let campaign = await client.getCampaign(campaignId);
        if (resubmission && ["TELNYX_FAILED", "MNO_REJECTED"].includes(campaign.campaignStatus ?? "")) {
          await client.updateCampaign(campaignId, draft);
          await client.appealCampaign(campaignId, "Corrected campaign message flow, samples, and opt-in evidence supplied by the customer.");
          campaign = await client.getCampaign(campaignId);
        }
        const expectedUsecase = draft.categories.includes("MARKETING") ? "MIXED" : "CUSTOMER_CARE";
        if (campaign.usecase && campaign.usecase !== expectedUsecase) {
          carrierStatus = "CAMPAIGN_PURPOSE_MISMATCH";
          reason = "The carrier campaign use case does not match the corrected registration. Contact support to register a different messaging program.";
          status = "REJECTED";
        } else {
        carrierStatus = campaign.campaignStatus ?? campaign.submissionStatus ?? "UNKNOWN";
        reason = campaign.failureReasons ?? null;
        let assignment = null;
        if (campaign.campaignStatus === "MNO_PROVISIONED" && campaign.submissionStatus === "CREATED") {
          try { assignment = await client.getAssignment(number.phoneNumber); }
          catch (error) {
            if (!(error instanceof ProviderRequestError && error.status === 404)) throw error;
          }
          if (!assignment && options.submitting) assignment = await client.assignNumber(number.phoneNumber, campaignId);
          if (!assignment && !options.submitting) assignment = await client.assignNumber(number.phoneNumber, campaignId);
        }
        if (assignment?.campaignId && assignment.campaignId !== campaignId) {
          reason = "Carrier number is assigned to a different messaging campaign.";
          status = "REJECTED";
        } else {
          status = tenDlcCarrierStatus({
            brandStatus: brand.status, identityStatus: brand.identityStatus,
            campaignStatus: campaign.campaignStatus, submissionStatus: campaign.submissionStatus,
            assignmentStatus: assignment?.assignmentStatus,
          });
          reason = reason ?? assignment?.failureReasons ?? null;
        }
        }
      }
    }
  } else {
    status = "REJECTED";
    reason = "Unsupported managed number type.";
  }
  await db.transaction(async (tx) => {
    // The registration and managed number are updated atomically; never publish READY
    // without the verified status and matching number assignment from Telnyx.
    await tx.update(smsRegistrations).set({
      status, carrierStatus, rejectionReason: status === "REJECTED" || carrierStatus === "Waiting For Customer" ? reason : null,
      carrierBrandId: brandId, carrierCampaignId: campaignId, carrierVerificationId: verificationId,
      ...(status === "READY" ? { approvedPolicy: approvedPolicyFromDraft(draft) } : { approvedPolicy: null }),
      submittedAt: registration.submittedAt ?? now, checkedAt: now, updatedAt: now,
    }).where(and(eq(smsRegistrations.workspaceId, workspaceId), eq(smsRegistrations.id, registration.id)));
    await tx.update(hostedPhoneNumbers).set({
      messagingReadiness: status, updatedAt: now,
    }).where(and(eq(hostedPhoneNumbers.workspaceId, workspaceId), eq(hostedPhoneNumbers.id, number.id)));
  });
  return status;
}

export async function processPendingSmsRegistrations(limit = BATCH_MAX) {
  const before = new Date(Date.now() - CHECK_INTERVAL_MS);
  const rows = await db.select({ workspaceId: smsRegistrations.workspaceId, id: smsRegistrations.id })
    .from(smsRegistrations).where(and(
      inArray(smsRegistrations.status, ["SUBMITTING", "PENDING", "READY"]),
      or(isNull(smsRegistrations.checkedAt), lt(smsRegistrations.checkedAt, before)),
    )).orderBy(asc(smsRegistrations.checkedAt))
    .limit(Math.min(Math.max(limit, 1), BATCH_MAX));
  let checked = 0;
  for (const row of rows) {
    // An untracked remote POST is never repeated after a timeout; reconciliation may
    // find an existing request but cannot safely manufacture missing brand IDs.
    try { await reconcileSmsRegistration(row.workspaceId, row.id); checked += 1; }
    catch (error) { logger.error({ err: error, registrationId: row.id }, "SMS carrier reconciliation failed"); }
    await db.update(smsRegistrations).set({ checkedAt: new Date() })
      .where(and(eq(smsRegistrations.id, row.id), eq(smsRegistrations.workspaceId, row.workspaceId)));
  }
  return { checked, total: rows.length };
}
