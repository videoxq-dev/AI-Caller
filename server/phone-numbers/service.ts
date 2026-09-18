import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { capabilityBindings, hostedPhoneNumbers, usageEvents } from "@/db/schema";
import { bindCapability } from "@/server/domain/integrations/repository";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import {
  createTelnyxCallControlApplication,
  createTelnyxMessagingProfile,
  deleteTelnyxCallControlApplication,
  deleteTelnyxMessagingProfile,
  findOwnedTelnyxNumber,
  orderTelnyxNumber,
  releaseTelnyxNumber,
  searchTelnyxNumbers,
} from "@/server/providers/telnyx-platform";
import {
  refundCredits,
  releaseCreditReservation,
  reserveCredits,
  settleCreditReservation,
} from "@/server/credits/service";
import { quoteHostedPhoneNumber } from "./pricing";
import { addBillingMonth } from "./billing-period";

export type ManagedNumberSearch = {
  phoneNumber: string;
  countryCode: string;
  administrativeArea: string | null;
  locality: string | null;
  numberType: string;
  monthlyCredits: number;
  purchaseCredits: number;
  monthlyCostMicros: number;
  upfrontCostMicros: number;
};

function publicNumber(row: typeof hostedPhoneNumbers.$inferSelect | null | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    phoneNumber: row.phoneNumber,
    countryCode: row.countryCode,
    administrativeArea: row.administrativeArea,
    locality: row.locality,
    numberType: row.numberType,
    status: row.status,
    monthlyCredits: row.monthlyCredits,
    purchaseCredits: row.purchaseCredits,
    currentPeriodEnd: row.currentPeriodEnd,
    nextBillingAt: row.nextBillingAt,
    graceEndsAt: row.graceEndsAt,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
  };
}

export async function getManagedPhoneNumber(workspaceId: string) {
  const [row] = await db.select().from(hostedPhoneNumbers)
    .where(and(
      eq(hostedPhoneNumbers.workspaceId, workspaceId),
      isNull(hostedPhoneNumbers.releasedAt),
      inArray(hostedPhoneNumbers.status, ["PROVISIONING", "ACTIVE", "PAST_DUE", "SUSPENDED"]),
    ))
    .orderBy(desc(hostedPhoneNumbers.createdAt))
    .limit(1);
  return publicNumber(row);
}

async function privateManagedPhoneNumber(workspaceId: string) {
  const [row] = await db.select().from(hostedPhoneNumbers)
    .where(and(
      eq(hostedPhoneNumbers.workspaceId, workspaceId),
      isNull(hostedPhoneNumbers.releasedAt),
      inArray(hostedPhoneNumbers.status, ["PROVISIONING", "ACTIVE", "PAST_DUE", "SUSPENDED"]),
    ))
    .orderBy(desc(hostedPhoneNumbers.createdAt))
    .limit(1);
  return row ?? null;
}

export async function searchManagedPhoneNumbers(input: {
  countryCode?: string | null;
  administrativeArea?: string | null;
  locality?: string | null;
  areaCode?: string | null;
  numberType?: "local" | "toll_free";
}) {
  const countryCode = input.countryCode?.trim().toUpperCase() || "US";
  if (countryCode !== "US") {
    throw new AppError("PHONE_COUNTRY_NOT_SUPPORTED", "Managed phone numbers are currently available in the United States.", 422);
  }
  const areaCode = input.areaCode?.replace(/\D/g, "") || null;
  if (areaCode && areaCode.length !== 3) {
    throw new AppError("INVALID_AREA_CODE", "US area codes must contain exactly three digits.", 422);
  }

  const numbers = await searchTelnyxNumbers({
    countryCode: "US",
    administrativeArea: input.administrativeArea,
    locality: input.locality,
    areaCode,
    numberType: input.numberType ?? "local",
    limit: 15,
  });

  return numbers.map((number): ManagedNumberSearch => {
    const quote = quoteHostedPhoneNumber(number);
    return {
      phoneNumber: number.phoneNumber,
      countryCode: number.countryCode,
      administrativeArea: number.administrativeArea ?? input.administrativeArea?.trim().toUpperCase() ?? null,
      locality: number.locality ?? input.locality?.trim() ?? null,
      numberType: number.numberType,
      monthlyCredits: quote.monthlyCredits,
      purchaseCredits: quote.purchaseCredits,
      monthlyCostMicros: quote.monthlyCostMicros,
      upfrontCostMicros: quote.upfrontCostMicros,
    };
  });
}

async function findFreshQuote(phoneNumber: string) {
  if (!/^\+1\d{10}$/.test(phoneNumber)) {
    throw new AppError("INVALID_PHONE_NUMBER", "Choose a valid US phone number from the current search results.", 422);
  }
  const national = phoneNumber.slice(2);
  const localNumbers = await searchTelnyxNumbers({
    countryCode: "US",
    startsWith: national,
    numberType: "local",
    limit: 20,
  });
  let match = localNumbers.find((number) => number.phoneNumber === phoneNumber);
  if (!match) {
    const tollFreeNumbers = await searchTelnyxNumbers({
      countryCode: "US",
      startsWith: national,
      numberType: "toll_free",
      limit: 20,
    });
    match = tollFreeNumbers.find((number) => number.phoneNumber === phoneNumber);
  }
  if (!match) throw new AppError("PHONE_NUMBER_UNAVAILABLE", "That phone number is no longer available. Search again and choose another number.", 409);
  return { match, quote: quoteHostedPhoneNumber(match) };
}

async function waitForOwnedNumber(phoneNumber: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const owned = await findOwnedTelnyxNumber(phoneNumber);
    if (owned?.id) return owned;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
  }
  return null;
}

async function cleanupProviderResources(input: {
  providerNumberId?: string | null;
  phoneNumber?: string | null;
  voiceConnectionId?: string | null;
  messagingProfileId?: string | null;
}) {
  let providerNumberId = input.providerNumberId ?? null;
  if (!providerNumberId && input.phoneNumber) {
    providerNumberId = (await findOwnedTelnyxNumber(input.phoneNumber))?.id ?? null;
  }
  if (input.phoneNumber && !providerNumberId) {
    throw new Error("The carrier phone number could not be located for release.");
  }
  if (providerNumberId) await releaseTelnyxNumber(providerNumberId);

  const cleanup = await Promise.allSettled([
    input.voiceConnectionId ? deleteTelnyxCallControlApplication(input.voiceConnectionId) : Promise.resolve(),
    input.messagingProfileId ? deleteTelnyxMessagingProfile(input.messagingProfileId) : Promise.resolve(),
  ]);
  for (const result of cleanup) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason, phoneNumber: input.phoneNumber }, "Managed Telnyx auxiliary resource cleanup failed");
    }
  }
}

async function createProvisioningRecord(
  workspaceId: string,
  expectedCurrentId: string | null,
  values: Omit<typeof hostedPhoneNumbers.$inferInsert, "workspaceId" | "id" | "createdAt" | "updatedAt">,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`managed-phone:${workspaceId}`}))`);
    const [latest] = await tx.select().from(hostedPhoneNumbers)
      .where(and(
        eq(hostedPhoneNumbers.workspaceId, workspaceId),
        isNull(hostedPhoneNumbers.releasedAt),
        inArray(hostedPhoneNumbers.status, ["PROVISIONING", "ACTIVE", "PAST_DUE", "SUSPENDED"]),
      ))
      .orderBy(desc(hostedPhoneNumbers.createdAt))
      .limit(1);

    if (latest?.status === "PROVISIONING") {
      throw new AppError("PHONE_NUMBER_PROVISIONING_IN_PROGRESS", "A phone number is already being activated for this workspace.", 409);
    }
    if ((latest?.id ?? null) !== expectedCurrentId) {
      throw new AppError("PHONE_NUMBER_CHANGED", "Your phone number changed while this request was being prepared. Refresh and try again.", 409);
    }

    const [row] = await tx.insert(hostedPhoneNumbers).values({
      ...values,
      workspaceId,
    }).returning();
    return row;
  });
}

async function markReleasePending(row: typeof hostedPhoneNumbers.$inferSelect) {
  await db.update(hostedPhoneNumbers).set({
    status: "RELEASE_PENDING",
    failureReason: "Carrier release is pending and will be retried automatically.",
    updatedAt: new Date(),
  }).where(eq(hostedPhoneNumbers.id, row.id));
}

async function finalizeRelease(row: typeof hostedPhoneNumbers.$inferSelect) {
  await cleanupProviderResources(row);
  await db.update(hostedPhoneNumbers).set({
    status: "RELEASED",
    releasedAt: new Date(),
    failureReason: null,
    updatedAt: new Date(),
  }).where(eq(hostedPhoneNumbers.id, row.id));
}

export async function provisionManagedPhoneNumber(workspaceId: string, input: {
  phoneNumber: string;
  requestId: string;
  replaceCurrent?: boolean;
}) {
  const current = await privateManagedPhoneNumber(workspaceId);
  if (current?.phoneNumber === input.phoneNumber && current.status !== "FAILED") return publicNumber(current);
  if (current && !input.replaceCurrent) {
    throw new AppError("PHONE_NUMBER_ALREADY_ASSIGNED", "This workspace already has a managed phone number.", 409);
  }

  const { match, quote } = await findFreshQuote(input.phoneNumber);
  const reservation = await reserveCredits(workspaceId, quote.purchaseCredits, {
    referenceType: "PHONE_NUMBER_PURCHASE",
    referenceId: input.requestId,
  });

  let row: typeof hostedPhoneNumbers.$inferSelect | undefined;
  let voiceConnectionId: string | null = null;
  let messagingProfileId: string | null = null;
  let providerOrderId: string | null = null;
  let providerNumberId: string | null = null;
  let purchased = false;
  let creditsSettled = false;

  try {
    row = await createProvisioningRecord(workspaceId, current?.id ?? null, {
      phoneNumber: match.phoneNumber,
      countryCode: "US",
      administrativeArea: match.administrativeArea,
      locality: match.locality,
      numberType: match.numberType,
      status: "PROVISIONING",
      provider: "telnyx",
      providerMonthlyCostMicros: quote.monthlyCostMicros,
      providerUpfrontCostMicros: quote.upfrontCostMicros,
      monthlyCredits: quote.monthlyCredits,
      purchaseCredits: quote.purchaseCredits,
    });

    const baseUrl = getEnv().BETTER_AUTH_URL.replace(/\/$/, "");
    voiceConnectionId = await createTelnyxCallControlApplication(
      workspaceId,
      `${baseUrl}/api/webhooks/voice/telnyx/${workspaceId}`,
    );
    messagingProfileId = await createTelnyxMessagingProfile(
      workspaceId,
      `${baseUrl}/api/webhooks/sms/telnyx/${workspaceId}`,
    );

    const order = await orderTelnyxNumber({
      workspaceId,
      phoneNumber: match.phoneNumber,
      connectionId: voiceConnectionId,
      messagingProfileId,
    });
    providerOrderId = order.id ?? null;
    purchased = true;

    const orderedNumber = order.phone_numbers?.find((number) => number.phone_number === match.phoneNumber);
    if (order.status === "failure" || orderedNumber?.status === "failure") {
      throw new AppError("PHONE_NUMBER_ORDER_FAILED", "The carrier could not provision that phone number. Search again and choose another number.", 409);
    }
    if (order.requirements_met === false || orderedNumber?.requirements_met === false) {
      throw new AppError("PHONE_NUMBER_REQUIREMENTS", "That number requires additional regulatory information and cannot be activated in self-service yet. Choose another number.", 409);
    }

    const owned = await waitForOwnedNumber(match.phoneNumber);
    providerNumberId = owned?.id ?? null;
    if (!providerNumberId) {
      throw new AppError("PHONE_NUMBER_ACTIVATION_PENDING", "The carrier did not finish activating this number in time. No credits were charged; please try again.", 503);
    }
    const now = new Date();
    const nextBillingAt = addBillingMonth(now);

    const [activated] = await db.update(hostedPhoneNumbers).set({
      providerNumberId,
      providerOrderId,
      voiceConnectionId,
      messagingProfileId,
      status: "ACTIVE",
      currentPeriodStart: now,
      currentPeriodEnd: nextBillingAt,
      nextBillingAt,
      graceEndsAt: null,
      failureReason: null,
      updatedAt: now,
    }).where(eq(hostedPhoneNumbers.id, row.id)).returning();

    await settleCreditReservation(workspaceId, reservation.id, quote.purchaseCredits, {
      reason: "Managed phone number purchase and first month",
      referenceType: "PHONE_NUMBER_PURCHASE",
      referenceId: input.requestId,
    });
    creditsSettled = true;

    await Promise.all([
      bindCapability(workspaceId, "VOICE", "HOSTED"),
      bindCapability(workspaceId, "SMS", "HOSTED"),
    ]);

    await db.insert(usageEvents).values({
      workspaceId,
      capability: "VOICE",
      provider: "telnyx",
      mode: "HOSTED",
      providerUsage: {
        kind: "PHONE_NUMBER_PURCHASE",
        phoneNumberId: activated.id,
        monthlyCostMicros: quote.monthlyCostMicros,
        upfrontCostMicros: quote.upfrontCostMicros,
      },
      creditsCharged: quote.purchaseCredits,
      providerCostMicros: quote.monthlyCostMicros + quote.upfrontCostMicros,
      billedUnits: {
        PHONE_NUMBER_MONTH: 1,
        ...(quote.upfrontCostMicros > 0 ? { PHONE_NUMBER_UPFRONT: 1 } : {}),
      },
      pricingDetails: {
        targetMarginBps: getEnv().HOSTED_TELEPHONY_TARGET_MARGIN_BPS,
      },
      referenceType: "PHONE_NUMBER_PURCHASE",
      referenceId: input.requestId,
    }).onConflictDoNothing();

    if (current && current.id !== activated.id) {
      await markReleasePending(current);
      try {
        await finalizeRelease(current);
      } catch (cleanupError) {
        logger.error({ err: cleanupError, workspaceId, phoneNumber: current.phoneNumber }, "Old managed phone number release will be retried");
      }
    }

    return publicNumber(activated);
  } catch (error) {
    let released = !purchased;
    if (purchased) {
      try {
        await cleanupProviderResources({
          providerNumberId,
          phoneNumber: match.phoneNumber,
          voiceConnectionId,
          messagingProfileId,
        });
        released = true;
      } catch (cleanupError) {
        logger.error({ err: cleanupError, workspaceId, phoneNumber: match.phoneNumber }, "Failed provisioning number release will be retried");
      }
    } else {
      await Promise.allSettled([
        voiceConnectionId ? deleteTelnyxCallControlApplication(voiceConnectionId) : Promise.resolve(),
        messagingProfileId ? deleteTelnyxMessagingProfile(messagingProfileId) : Promise.resolve(),
      ]);
    }

    if (row) {
      await db.update(hostedPhoneNumbers).set({
        status: released ? "FAILED" : "RELEASE_PENDING",
        providerNumberId,
        providerOrderId,
        voiceConnectionId,
        messagingProfileId,
        failureReason: error instanceof Error ? error.message.slice(0, 500) : "Phone provisioning failed.",
        releasedAt: released ? new Date() : null,
        updatedAt: new Date(),
      }).where(eq(hostedPhoneNumbers.id, row.id));
      await clearHostedTelephonyBindingsIfUnused(workspaceId).catch((bindingError) => {
        logger.error({ err: bindingError, workspaceId }, "Failed to reconcile hosted telephony bindings after provisioning failure");
      });
    }
    if (creditsSettled) {
      await refundCredits(workspaceId, quote.purchaseCredits, {
        reason: "Managed phone number activation failed",
        referenceType: "PHONE_NUMBER_PURCHASE_REFUND",
        referenceId: input.requestId,
      }).catch((refundError) => logger.error({ err: refundError, workspaceId }, "Failed to refund phone number purchase credits"));
    } else {
      await releaseCreditReservation(workspaceId, reservation.id).catch(() => undefined);
    }
    throw error;
  }
}

export async function releaseManagedPhoneNumber(workspaceId: string, phoneNumberId: string) {
  const [row] = await db.select().from(hostedPhoneNumbers).where(and(
    eq(hostedPhoneNumbers.workspaceId, workspaceId),
    eq(hostedPhoneNumbers.id, phoneNumberId),
    isNull(hostedPhoneNumbers.releasedAt),
  )).limit(1);
  if (!row) throw new AppError("PHONE_NUMBER_NOT_FOUND", "Managed phone number not found.", 404);

  await markReleasePending(row);
  try {
    await finalizeRelease(row);
  } catch (error) {
    throw new AppError("PHONE_NUMBER_RELEASE_PENDING", "The carrier could not release this number immediately. AI Caller will retry automatically.", 503);
  }
  await clearHostedTelephonyBindingsIfUnused(workspaceId);
  const [released] = await db.select().from(hostedPhoneNumbers).where(eq(hostedPhoneNumbers.id, row.id)).limit(1);
  return publicNumber(released);
}

async function clearHostedTelephonyBindingsIfUnused(workspaceId: string) {
  const [active] = await db.select({ id: hostedPhoneNumbers.id }).from(hostedPhoneNumbers).where(and(
    eq(hostedPhoneNumbers.workspaceId, workspaceId),
    isNull(hostedPhoneNumbers.releasedAt),
    inArray(hostedPhoneNumbers.status, ["PROVISIONING", "ACTIVE", "PAST_DUE", "SUSPENDED"]),
  )).limit(1);
  if (active) return;
  await db.delete(capabilityBindings).where(and(
    eq(capabilityBindings.workspaceId, workspaceId),
    inArray(capabilityBindings.capability, ["VOICE", "SMS"]),
  ));
}

export async function processPendingPhoneNumberReleases(limit = 50) {
  const rows = await db.select().from(hostedPhoneNumbers).where(and(
    isNull(hostedPhoneNumbers.releasedAt),
    eq(hostedPhoneNumbers.status, "RELEASE_PENDING"),
  )).orderBy(hostedPhoneNumbers.updatedAt).limit(Math.min(Math.max(limit, 1), 100));

  let released = 0;
  for (const row of rows) {
    try {
      await finalizeRelease(row);
      await clearHostedTelephonyBindingsIfUnused(row.workspaceId);
      released += 1;
    } catch (error) {
      logger.error({ err: error, workspaceId: row.workspaceId, phoneNumber: row.phoneNumber }, "Managed phone number release retry failed");
    }
  }
  return { checked: rows.length, released };
}

export async function processDuePhoneNumberRenewals(limit = 100) {
  const now = new Date();
  const rows = await db.select().from(hostedPhoneNumbers).where(and(
    isNull(hostedPhoneNumbers.releasedAt),
    inArray(hostedPhoneNumbers.status, ["ACTIVE", "PAST_DUE", "SUSPENDED"]),
    lte(hostedPhoneNumbers.nextBillingAt, now),
  )).orderBy(hostedPhoneNumbers.nextBillingAt).limit(Math.min(Math.max(limit, 1), 250));

  let renewed = 0;
  let pastDue = 0;
  let suspended = 0;

  for (const row of rows) {
    if (!row.nextBillingAt) continue;
    const referenceId = `${row.id}:${row.nextBillingAt.toISOString()}`;
    try {
      const reservation = await reserveCredits(row.workspaceId, row.monthlyCredits, {
        referenceType: "PHONE_NUMBER_RENEWAL",
        referenceId,
      });
      await settleCreditReservation(row.workspaceId, reservation.id, row.monthlyCredits, {
        reason: "Managed phone number monthly renewal",
        referenceType: "PHONE_NUMBER_RENEWAL",
        referenceId,
      });
      await db.insert(usageEvents).values({
        workspaceId: row.workspaceId,
        capability: "VOICE",
        provider: row.provider,
        mode: "HOSTED",
        providerUsage: {
          kind: "PHONE_NUMBER_RENEWAL",
          phoneNumberId: row.id,
          periodStart: row.nextBillingAt.toISOString(),
        },
        creditsCharged: row.monthlyCredits,
        providerCostMicros: row.providerMonthlyCostMicros,
        billedUnits: { PHONE_NUMBER_MONTH: 1 },
        pricingDetails: {
          targetMarginBps: getEnv().HOSTED_TELEPHONY_TARGET_MARGIN_BPS,
        },
        referenceType: "PHONE_NUMBER_RENEWAL",
        referenceId,
      }).onConflictDoNothing();
      const next = addBillingMonth(row.nextBillingAt);
      await db.update(hostedPhoneNumbers).set({
        status: "ACTIVE",
        currentPeriodStart: row.nextBillingAt,
        currentPeriodEnd: next,
        nextBillingAt: next,
        graceEndsAt: null,
        failureReason: null,
        updatedAt: now,
      }).where(eq(hostedPhoneNumbers.id, row.id));
      renewed += 1;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "INSUFFICIENT_CREDITS") throw error;
      const graceEndsAt = row.graceEndsAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const isSuspended = graceEndsAt <= now;
      await db.update(hostedPhoneNumbers).set({
        status: isSuspended ? "SUSPENDED" : "PAST_DUE",
        graceEndsAt,
        failureReason: isSuspended
          ? "Phone service is suspended until enough credits are available for renewal."
          : "Phone number renewal is waiting for additional credits.",
        updatedAt: now,
      }).where(eq(hostedPhoneNumbers.id, row.id));
      if (isSuspended) suspended += 1;
      else pastDue += 1;
    }
  }

  return { checked: rows.length, renewed, pastDue, suspended };
}

export async function getHostedPhoneWebhookRecord(workspaceId: string) {
  const [row] = await db.select().from(hostedPhoneNumbers).where(and(
    eq(hostedPhoneNumbers.workspaceId, workspaceId),
    isNull(hostedPhoneNumbers.releasedAt),
    inArray(hostedPhoneNumbers.status, ["ACTIVE", "PAST_DUE", "SUSPENDED"]),
  )).orderBy(desc(hostedPhoneNumbers.createdAt)).limit(1);
  if (!row) throw new Error("No managed phone number is available for this workspace webhook.");
  return row;
}

export async function getHostedPhoneRuntimeRecord(workspaceId: string) {
  const [row] = await db.select().from(hostedPhoneNumbers).where(and(
    eq(hostedPhoneNumbers.workspaceId, workspaceId),
    isNull(hostedPhoneNumbers.releasedAt),
    inArray(hostedPhoneNumbers.status, ["ACTIVE", "PAST_DUE"]),
  )).orderBy(desc(hostedPhoneNumbers.createdAt)).limit(1);
  if (!row) throw new Error("No active managed phone number is configured for this workspace.");
  return row;
}
