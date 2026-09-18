import { and, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
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
  findTelnyxNumberOrderByReference,
  orderTelnyxNumber,
  releaseTelnyxNumber,
  retrieveTelnyxNumberOrder,
  retrieveTelnyxOrderPhoneNumber,
  searchTelnyxNumbers,
} from "@/server/providers/telnyx-platform";
import {
  releaseCreditReservation,
  reserveCredits,
  settleCreditReservation,
} from "@/server/credits/service";
import { ProviderRequestError } from "@/server/providers/http";
import { quoteHostedPhoneNumber } from "./pricing";
import { addBillingMonth } from "./billing-period";
import { carrierProvisioningOutcome } from "./lifecycle";

export type ManagedNumberSearch = {
  phoneNumber: string;
  countryCode: string;
  administrativeArea: string | null;
  locality: string | null;
  numberType: string;
  monthlyCredits: number;
  purchaseCredits: number;
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
    messagingReadiness: row.messagingReadiness,
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
      inArray(hostedPhoneNumbers.status, ["PROVISIONING", "RECONCILING", "ACTIVE", "PAST_DUE", "SUSPENDED"]),
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
      inArray(hostedPhoneNumbers.status, ["PROVISIONING", "RECONCILING", "ACTIVE", "PAST_DUE", "SUSPENDED"]),
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

const PROVISIONING_RECONCILE_DELAY_MS = 15_000;
const REQUIREMENTS_RECONCILE_DELAY_MS = 5 * 60_000;
const INDETERMINATE_PURCHASE_MAX_MS = 30 * 60_000;

function uncertainProviderFailure(error: unknown) {
  return !(error instanceof ProviderRequestError) || error.status >= 500;
}

async function cleanupAuxiliaryResources(input: {
  voiceConnectionId?: string | null;
  messagingProfileId?: string | null;
  phoneNumber?: string | null;
}) {
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
  await cleanupAuxiliaryResources(input);
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
        inArray(hostedPhoneNumbers.status, ["PROVISIONING", "RECONCILING", "ACTIVE", "PAST_DUE", "SUSPENDED"]),
      ))
      .orderBy(desc(hostedPhoneNumbers.createdAt))
      .limit(1);

    if (latest && (latest.status === "PROVISIONING" || latest.status === "RECONCILING")) {
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
    reconcileAfter: null,
    updatedAt: new Date(),
  }).where(eq(hostedPhoneNumbers.id, row.id));
}

async function recordPhonePurchaseUsage(row: typeof hostedPhoneNumbers.$inferSelect) {
  if (!row.provisionRequestId) throw new Error("Managed phone provisioning request ID is missing.");
  await db.insert(usageEvents).values({
    workspaceId: row.workspaceId,
    capability: "VOICE",
    provider: row.provider,
    mode: "HOSTED",
    providerUsage: {
      kind: "PHONE_NUMBER_PURCHASE",
      phoneNumberId: row.id,
      monthlyCostMicros: row.providerMonthlyCostMicros,
      upfrontCostMicros: row.providerUpfrontCostMicros,
    },
    creditsCharged: row.purchaseCredits,
    providerCostMicros: row.providerMonthlyCostMicros + row.providerUpfrontCostMicros,
    billedUnits: {
      PHONE_NUMBER_MONTH: 1,
      ...(row.providerUpfrontCostMicros > 0 ? { PHONE_NUMBER_UPFRONT: 1 } : {}),
    },
    pricingDetails: {
      targetMarginBps: getEnv().HOSTED_TELEPHONY_TARGET_MARGIN_BPS,
    },
    referenceType: "PHONE_NUMBER_PURCHASE",
    referenceId: row.provisionRequestId,
  }).onConflictDoNothing();
}

async function releasePreviousManagedNumbers(activeRow: typeof hostedPhoneNumbers.$inferSelect) {
  const previous = await db.select().from(hostedPhoneNumbers).where(and(
    eq(hostedPhoneNumbers.workspaceId, activeRow.workspaceId),
    ne(hostedPhoneNumbers.id, activeRow.id),
    isNull(hostedPhoneNumbers.releasedAt),
    inArray(hostedPhoneNumbers.status, ["ACTIVE", "PAST_DUE", "SUSPENDED"]),
  ));

  for (const row of previous) {
    await markReleasePending(row);
    try {
      await finalizeRelease(row);
    } catch (error) {
      logger.error({ err: error, workspaceId: row.workspaceId, phoneNumber: row.phoneNumber }, "Previous managed number release will be retried");
    }
  }
}

async function activateProvisionedNumber(
  row: typeof hostedPhoneNumbers.$inferSelect,
  providerNumberId: string,
  providerOrderStatus: string | null,
) {
  if (!row.provisionRequestId) throw new Error("Managed phone provisioning request ID is missing.");

  const reservation = await reserveCredits(row.workspaceId, row.purchaseCredits, {
    referenceType: "PHONE_NUMBER_PURCHASE",
    referenceId: row.provisionRequestId,
  });
  await settleCreditReservation(row.workspaceId, reservation.id, row.purchaseCredits, {
    reason: "Managed phone number purchase and first month",
    referenceType: "PHONE_NUMBER_PURCHASE",
    referenceId: row.provisionRequestId,
  });

  await Promise.all([
    bindCapability(row.workspaceId, "VOICE", "HOSTED"),
    bindCapability(row.workspaceId, "SMS", "HOSTED"),
  ]);
  await recordPhonePurchaseUsage(row);

  const now = new Date();
  const nextBillingAt = addBillingMonth(now);
  const [activated] = await db.update(hostedPhoneNumbers).set({
    providerNumberId,
    providerOrderStatus: providerOrderStatus ?? "success",
    status: "ACTIVE",
    currentPeriodStart: now,
    currentPeriodEnd: nextBillingAt,
    nextBillingAt,
    graceEndsAt: null,
    provisioningLastCheckedAt: now,
    reconcileAfter: null,
    failureReason: null,
    updatedAt: now,
  }).where(eq(hostedPhoneNumbers.id, row.id)).returning();

  await releasePreviousManagedNumbers(activated);
  return activated;
}

async function failProvisioning(
  row: typeof hostedPhoneNumbers.$inferSelect,
  reason: string,
  providerOrderStatus: string | null,
) {
  let ownedId = row.providerNumberId;
  if (!ownedId) {
    try {
      ownedId = (await findOwnedTelnyxNumber(row.phoneNumber))?.id ?? null;
    } catch (error) {
      logger.warn({ err: error, workspaceId: row.workspaceId, phoneNumber: row.phoneNumber }, "Could not check carrier ownership while failing provisioning");
    }
  }

  if (ownedId) {
    try {
      await cleanupProviderResources({ ...row, providerNumberId: ownedId });
    } catch (error) {
      await db.update(hostedPhoneNumbers).set({
        providerNumberId: ownedId,
        providerOrderStatus,
        status: "RELEASE_PENDING",
        failureReason: reason.slice(0, 500),
        reconcileAfter: null,
        updatedAt: new Date(),
      }).where(eq(hostedPhoneNumbers.id, row.id));
      return;
    }
  } else {
    await cleanupAuxiliaryResources(row);
  }

  if (row.provisionRequestId) {
    const reservation = await reserveCredits(row.workspaceId, row.purchaseCredits, {
      referenceType: "PHONE_NUMBER_PURCHASE",
      referenceId: row.provisionRequestId,
    });
    await releaseCreditReservation(row.workspaceId, reservation.id).catch(() => undefined);
  }

  await db.update(hostedPhoneNumbers).set({
    providerNumberId: ownedId,
    providerOrderStatus,
    status: "FAILED",
    failureReason: reason.slice(0, 500),
    reconcileAfter: null,
    releasedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(hostedPhoneNumbers.id, row.id));
}

function ownedNumberIsUsable(
  owned: { id?: string; status?: string } | null | undefined,
): owned is { id: string; status?: string } {
  const status = owned?.status?.trim().toLowerCase();
  return Boolean(owned?.id && (status === "active" || status === "success"));
}

async function reconcileProvisioningRow(row: typeof hostedPhoneNumbers.$inferSelect) {
  if (row.status !== "PROVISIONING" && row.status !== "RECONCILING") return row;

  const now = new Date();
  try {
    if (!row.providerOrderId) {
      if (!row.provisionRequestId) throw new Error("Managed phone provisioning request ID is missing.");

      const discoveredOrder = await findTelnyxNumberOrderByReference({
        workspaceId: row.workspaceId,
        requestId: row.provisionRequestId,
        phoneNumber: row.phoneNumber,
      });
      if (discoveredOrder?.id) {
        const discoveredNumber = discoveredOrder.phone_numbers?.find((number) => number.phone_number === row.phoneNumber) ?? null;
        const [withOrder] = await db.update(hostedPhoneNumbers).set({
          providerOrderId: discoveredOrder.id,
          providerOrderPhoneNumberId: discoveredNumber?.id ?? null,
          providerOrderStatus: discoveredOrder.status ?? null,
          provisioningLastCheckedAt: now,
          reconcileAfter: new Date(),
          failureReason: "AI Caller recovered the carrier order after an indeterminate purchase response.",
          updatedAt: now,
        }).where(eq(hostedPhoneNumbers.id, row.id)).returning();
        return reconcileProvisioningRow(withOrder);
      }

      const owned = await findOwnedTelnyxNumber(row.phoneNumber);
      if (ownedNumberIsUsable(owned)) {
        return activateProvisionedNumber(row, owned.id, "reconciled");
      }

      if (now.getTime() - row.createdAt.getTime() >= INDETERMINATE_PURCHASE_MAX_MS) {
        await failProvisioning(
          row,
          "The carrier did not create an order or own the requested number after repeated reconciliation checks.",
          "not_found",
        );
        const [failed] = await db.select().from(hostedPhoneNumbers).where(eq(hostedPhoneNumbers.id, row.id)).limit(1);
        return failed;
      }

      const [pending] = await db.update(hostedPhoneNumbers).set({
        status: "RECONCILING",
        provisioningLastCheckedAt: now,
        reconcileAfter: new Date(now.getTime() + PROVISIONING_RECONCILE_DELAY_MS),
        failureReason: "The carrier purchase response was indeterminate. AI Caller is checking the exact order reference and phone-number ownership before charging, refunding, or retrying.",
        updatedAt: now,
      }).where(eq(hostedPhoneNumbers.id, row.id)).returning();
      return pending;
    }

    const order = await retrieveTelnyxNumberOrder(row.providerOrderId);
    const orderedNumber = row.providerOrderPhoneNumberId
      ? await retrieveTelnyxOrderPhoneNumber(row.providerOrderPhoneNumberId)
      : order.phone_numbers?.find((number) => number.phone_number === row.phoneNumber) ?? null;
    const outcome = carrierProvisioningOutcome(order, orderedNumber);

    if (outcome.kind === "FAILED") {
      await failProvisioning(row, "The carrier reported that the phone-number order failed.", outcome.orderStatus);
      const [failed] = await db.select().from(hostedPhoneNumbers).where(eq(hostedPhoneNumbers.id, row.id)).limit(1);
      return failed;
    }

    if (outcome.kind === "REQUIREMENTS") {
      const [pending] = await db.update(hostedPhoneNumbers).set({
        providerOrderStatus: outcome.orderStatus,
        status: "PROVISIONING",
        provisioningLastCheckedAt: now,
        reconcileAfter: new Date(now.getTime() + REQUIREMENTS_RECONCILE_DELAY_MS),
        failureReason: "The carrier requires additional number-order information before this phone number can become active.",
        updatedAt: now,
      }).where(eq(hostedPhoneNumbers.id, row.id)).returning();
      return pending;
    }

    if (outcome.kind === "PENDING") {
      const [pending] = await db.update(hostedPhoneNumbers).set({
        providerOrderStatus: outcome.orderStatus,
        status: "PROVISIONING",
        provisioningLastCheckedAt: now,
        reconcileAfter: new Date(now.getTime() + PROVISIONING_RECONCILE_DELAY_MS),
        failureReason: "The carrier is still finalizing this phone-number purchase.",
        updatedAt: now,
      }).where(eq(hostedPhoneNumbers.id, row.id)).returning();
      return pending;
    }

    const owned = await findOwnedTelnyxNumber(row.phoneNumber);
    if (!ownedNumberIsUsable(owned)) {
      const [pending] = await db.update(hostedPhoneNumbers).set({
        providerOrderStatus: outcome.orderStatus,
        status: "PROVISIONING",
        provisioningLastCheckedAt: now,
        reconcileAfter: new Date(now.getTime() + PROVISIONING_RECONCILE_DELAY_MS),
        failureReason: owned?.id
          ? "The carrier completed the order, but the owned phone number is not active yet."
          : "The carrier completed the order and is still publishing the phone number to account inventory.",
        updatedAt: now,
      }).where(eq(hostedPhoneNumbers.id, row.id)).returning();
      return pending;
    }

    return activateProvisionedNumber(row, owned.id, outcome.orderStatus);
  } catch (error) {
    const [pending] = await db.update(hostedPhoneNumbers).set({
      status: "RECONCILING",
      provisioningLastCheckedAt: now,
      reconcileAfter: new Date(now.getTime() + PROVISIONING_RECONCILE_DELAY_MS),
      failureReason: error instanceof Error
        ? `Carrier reconciliation is temporarily unavailable: ${error.message}`.slice(0, 500)
        : "Carrier reconciliation is temporarily unavailable.",
      updatedAt: now,
    }).where(eq(hostedPhoneNumbers.id, row.id)).returning();
    return pending;
  }
}

async function reconcileProvisioningById(id: string) {
  const [row] = await db.select().from(hostedPhoneNumbers).where(eq(hostedPhoneNumbers.id, id)).limit(1);
  if (!row) throw new Error("Managed phone provisioning record not found.");
  return reconcileProvisioningRow(row);
}

async function shortProvisioningPoll(id: string) {
  for (const delayMs of [250, 600, 1_200]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const row = await reconcileProvisioningById(id);
    if (row.status !== "PROVISIONING" && row.status !== "RECONCILING") return row;
  }
  return reconcileProvisioningById(id);
}

export async function provisionManagedPhoneNumber(workspaceId: string, input: {
  phoneNumber: string;
  requestId: string;
  expectedPurchaseCredits: number;
  expectedMonthlyCredits: number;
  replaceCurrent?: boolean;
}) {
  const [priorRequest] = await db.select().from(hostedPhoneNumbers).where(and(
    eq(hostedPhoneNumbers.workspaceId, workspaceId),
    eq(hostedPhoneNumbers.provisionRequestId, input.requestId),
  )).limit(1);
  if (priorRequest) {
    if (priorRequest.phoneNumber !== input.phoneNumber) {
      throw new AppError("PHONE_NUMBER_IDEMPOTENCY_CONFLICT", "This provisioning request was already used for a different phone number.", 409);
    }
    return publicNumber(priorRequest);
  }

  const current = await privateManagedPhoneNumber(workspaceId);
  if (current?.phoneNumber === input.phoneNumber) return publicNumber(current);
  if (current && !input.replaceCurrent) {
    throw new AppError("PHONE_NUMBER_ALREADY_ASSIGNED", "This workspace already has a managed phone number.", 409);
  }

  const { match, quote } = await findFreshQuote(input.phoneNumber);
  if (quote.purchaseCredits !== input.expectedPurchaseCredits || quote.monthlyCredits !== input.expectedMonthlyCredits) {
    throw new AppError(
      "PHONE_NUMBER_PRICE_CHANGED",
      "The carrier price for that number changed. Search again and confirm the updated price before purchasing.",
      409,
    );
  }
  const reservation = await reserveCredits(workspaceId, quote.purchaseCredits, {
    referenceType: "PHONE_NUMBER_PURCHASE",
    referenceId: input.requestId,
  });

  let row: typeof hostedPhoneNumbers.$inferSelect | undefined;
  let voiceConnectionId: string | null = null;
  let messagingProfileId: string | null = null;

  try {
    row = await createProvisioningRecord(workspaceId, current?.id ?? null, {
      phoneNumber: match.phoneNumber,
      countryCode: "US",
      administrativeArea: match.administrativeArea,
      locality: match.locality,
      numberType: match.numberType,
      status: "PROVISIONING",
      messagingReadiness: "NOT_REGISTERED",
      provider: "telnyx",
      provisionRequestId: input.requestId,
      providerMonthlyCostMicros: quote.monthlyCostMicros,
      providerUpfrontCostMicros: quote.upfrontCostMicros,
      monthlyCredits: quote.monthlyCredits,
      purchaseCredits: quote.purchaseCredits,
      reconcileAfter: new Date(),
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
    [row] = await db.update(hostedPhoneNumbers).set({
      voiceConnectionId,
      messagingProfileId,
      updatedAt: new Date(),
    }).where(eq(hostedPhoneNumbers.id, row.id)).returning();

    let order: Awaited<ReturnType<typeof orderTelnyxNumber>>;
    try {
      order = await orderTelnyxNumber({
        workspaceId,
        requestId: input.requestId,
        phoneNumber: match.phoneNumber,
        connectionId: voiceConnectionId,
        messagingProfileId,
      });
    } catch (error) {
      if (!uncertainProviderFailure(error)) throw error;
      const [reconciling] = await db.update(hostedPhoneNumbers).set({
        status: "RECONCILING",
        providerOrderStatus: "unknown",
        provisioningLastCheckedAt: new Date(),
        reconcileAfter: new Date(Date.now() + PROVISIONING_RECONCILE_DELAY_MS),
        failureReason: "The carrier purchase response was indeterminate. AI Caller is reconciling the exact number before charging, refunding, or retrying.",
        updatedAt: new Date(),
      }).where(eq(hostedPhoneNumbers.id, row.id)).returning();
      return publicNumber(reconciling);
    }

    const orderedNumber = order.phone_numbers?.find((number) => number.phone_number === match.phoneNumber) ?? null;
    [row] = await db.update(hostedPhoneNumbers).set({
      providerOrderId: order.id ?? null,
      providerOrderPhoneNumberId: orderedNumber?.id ?? null,
      providerOrderStatus: order.status ?? null,
      status: "PROVISIONING",
      provisioningLastCheckedAt: new Date(),
      reconcileAfter: new Date(),
      failureReason: null,
      updatedAt: new Date(),
    }).where(eq(hostedPhoneNumbers.id, row.id)).returning();

    const initialOutcome = carrierProvisioningOutcome(order, orderedNumber);
    if (initialOutcome.kind === "FAILED") {
      await failProvisioning(row, "The carrier rejected the phone-number order.", initialOutcome.orderStatus);
      throw new AppError("PHONE_NUMBER_ORDER_FAILED", "The carrier could not provision that phone number. Search again and choose another number.", 409);
    }

    const reconciled = await shortProvisioningPoll(row.id);
    if (reconciled.status === "FAILED") {
      throw new AppError(
        "PHONE_NUMBER_ORDER_FAILED",
        reconciled.failureReason ?? "The carrier could not provision that phone number. Search again and choose another number.",
        409,
      );
    }
    if (reconciled.status === "RELEASE_PENDING") {
      throw new AppError(
        "PHONE_NUMBER_RELEASE_PENDING",
        "The carrier rejected that number and cleanup is still pending. Choose another number while AI Caller finishes the release.",
        503,
      );
    }
    return publicNumber(reconciled);
  } catch (error) {
    if (row && (row.status === "RECONCILING" || row.providerOrderId)) throw error;

    await cleanupAuxiliaryResources({
      phoneNumber: match.phoneNumber,
      voiceConnectionId,
      messagingProfileId,
    });
    if (row) {
      await db.update(hostedPhoneNumbers).set({
        status: "FAILED",
        failureReason: error instanceof Error ? error.message.slice(0, 500) : "Phone provisioning failed.",
        reconcileAfter: null,
        releasedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(hostedPhoneNumbers.id, row.id));
    }
    await releaseCreditReservation(workspaceId, reservation.id).catch(() => undefined);
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
    inArray(hostedPhoneNumbers.status, ["PROVISIONING", "RECONCILING", "ACTIVE", "PAST_DUE", "SUSPENDED"]),
  )).limit(1);
  if (active) return;
  await db.delete(capabilityBindings).where(and(
    eq(capabilityBindings.workspaceId, workspaceId),
    inArray(capabilityBindings.capability, ["VOICE", "SMS"]),
  ));
}

export async function processPendingPhoneNumberProvisioning(limit = 50) {
  const now = new Date();
  const rows = await db.select().from(hostedPhoneNumbers).where(and(
    isNull(hostedPhoneNumbers.releasedAt),
    inArray(hostedPhoneNumbers.status, ["PROVISIONING", "RECONCILING"]),
    or(isNull(hostedPhoneNumbers.reconcileAfter), lte(hostedPhoneNumbers.reconcileAfter, now)),
  )).orderBy(hostedPhoneNumbers.reconcileAfter).limit(Math.min(Math.max(limit, 1), 100));

  let activated = 0;
  let pending = 0;
  let failed = 0;
  let releasePending = 0;

  for (const row of rows) {
    const next = await reconcileProvisioningRow(row);
    if (next.status === "ACTIVE") activated += 1;
    else if (next.status === "FAILED") failed += 1;
    else if (next.status === "RELEASE_PENDING") releasePending += 1;
    else pending += 1;
  }

  return { checked: rows.length, activated, pending, failed, releasePending };
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
