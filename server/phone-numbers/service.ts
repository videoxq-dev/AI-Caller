import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { hostedPhoneNumbers } from "@/db/schema";
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
  releaseCreditReservation,
  reserveCredits,
  settleCreditReservation,
} from "@/server/credits/service";
import { quoteHostedPhoneNumber } from "./pricing";

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

function addBillingMonth(value: Date) {
  const source = new Date(value);
  const day = source.getUTCDate();
  const year = source.getUTCFullYear();
  const month = source.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  source.setUTCDate(1);
  source.setUTCMonth(month);
  source.setUTCDate(Math.min(day, lastDay));
  return source;
}

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
    .where(and(eq(hostedPhoneNumbers.workspaceId, workspaceId), isNull(hostedPhoneNumbers.releasedAt)))
    .orderBy(desc(hostedPhoneNumbers.createdAt))
    .limit(1);
  return publicNumber(row);
}

async function privateManagedPhoneNumber(workspaceId: string) {
  const [row] = await db.select().from(hostedPhoneNumbers)
    .where(and(eq(hostedPhoneNumbers.workspaceId, workspaceId), isNull(hostedPhoneNumbers.releasedAt)))
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
  const numbers = await searchTelnyxNumbers({
    countryCode: "US",
    startsWith: national,
    numberType: "local",
    limit: 20,
  });
  const match = numbers.find((number) => number.phoneNumber === phoneNumber);
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
  try {
    if (!providerNumberId && input.phoneNumber) {
      providerNumberId = (await findOwnedTelnyxNumber(input.phoneNumber))?.id ?? null;
    }
    if (providerNumberId) await releaseTelnyxNumber(providerNumberId);
  } catch (error) {
    logger.error({ err: error, phoneNumber: input.phoneNumber }, "Failed to release managed Telnyx phone number");
  }
  await Promise.allSettled([
    input.voiceConnectionId ? deleteTelnyxCallControlApplication(input.voiceConnectionId) : Promise.resolve(),
    input.messagingProfileId ? deleteTelnyxMessagingProfile(input.messagingProfileId) : Promise.resolve(),
  ]);
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

  try {
    [row] = await db.insert(hostedPhoneNumbers).values({
      workspaceId,
      phoneNumber: match.phoneNumber,
      countryCode: "US",
      administrativeArea: match.administrativeArea,
      locality: match.locality,
      numberType: match.numberType,
      status: "PROVISIONING",
      providerMonthlyCostMicros: quote.monthlyCostMicros,
      providerUpfrontCostMicros: quote.upfrontCostMicros,
      monthlyCredits: quote.monthlyCredits,
      purchaseCredits: quote.purchaseCredits,
    }).returning();

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

    await Promise.all([
      bindCapability(workspaceId, "VOICE", "HOSTED"),
      bindCapability(workspaceId, "SMS", "HOSTED"),
    ]);

    await settleCreditReservation(workspaceId, reservation.id, quote.purchaseCredits, {
      reason: "Managed phone number purchase and first month",
      referenceType: "PHONE_NUMBER_PURCHASE",
      referenceId: input.requestId,
    });

    if (current && current.id !== activated.id) {
      await cleanupProviderResources(current);
      await db.update(hostedPhoneNumbers).set({
        status: "RELEASED",
        releasedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(hostedPhoneNumbers.id, current.id));
    }

    return publicNumber(activated);
  } catch (error) {
    if (purchased) {
      await cleanupProviderResources({
        providerNumberId,
        phoneNumber: match.phoneNumber,
        voiceConnectionId,
        messagingProfileId,
      });
    } else {
      await Promise.allSettled([
        voiceConnectionId ? deleteTelnyxCallControlApplication(voiceConnectionId) : Promise.resolve(),
        messagingProfileId ? deleteTelnyxMessagingProfile(messagingProfileId) : Promise.resolve(),
      ]);
    }

    if (row) {
      await db.update(hostedPhoneNumbers).set({
        status: "FAILED",
        providerNumberId,
        providerOrderId,
        voiceConnectionId,
        messagingProfileId,
        failureReason: error instanceof Error ? error.message.slice(0, 500) : "Phone provisioning failed.",
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

  await cleanupProviderResources(row);
  const [released] = await db.update(hostedPhoneNumbers).set({
    status: "RELEASED",
    releasedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(hostedPhoneNumbers.id, row.id)).returning();
  return publicNumber(released);
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

export async function getHostedPhoneRuntimeRecord(workspaceId: string) {
  const [row] = await db.select().from(hostedPhoneNumbers).where(and(
    eq(hostedPhoneNumbers.workspaceId, workspaceId),
    isNull(hostedPhoneNumbers.releasedAt),
    inArray(hostedPhoneNumbers.status, ["ACTIVE", "PAST_DUE"]),
  )).orderBy(desc(hostedPhoneNumbers.createdAt)).limit(1);
  if (!row) throw new Error("No active managed phone number is configured for this workspace.");
  return row;
}
