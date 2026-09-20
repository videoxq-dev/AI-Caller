import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { hostedApiRateCards } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import type { Capability } from "@/server/providers/contracts";

export type HostedPricingUnit =
  | "AI_INPUT_TOKEN"
  | "AI_CACHED_INPUT_TOKEN"
  | "AI_OUTPUT_TOKEN"
  | "SMS_SEGMENT"
  | "VOICE_MINUTE"
  | "VOICE_REALTIME_AUDIO_INPUT_TOKEN"
  | "VOICE_REALTIME_AUDIO_CACHED_INPUT_TOKEN"
  | "VOICE_REALTIME_AUDIO_OUTPUT_TOKEN"
  | "VOICE_REALTIME_TEXT_INPUT_TOKEN"
  | "VOICE_REALTIME_TEXT_CACHED_INPUT_TOKEN"
  | "VOICE_REALTIME_TEXT_OUTPUT_TOKEN"
  | "VOICE_REALTIME_CARRIER_MINUTE"
  | "VOICE_REALTIME_STREAM_MINUTE"
  | "VOICE_REALTIME_RECORDING_MINUTE"
  | "VOICE_REALTIME_TRANSCRIPTION_MINUTE"
  | "VOICE_REALTIME_GREETING_TTS_CHAR";

export type HostedRate = {
  id: string;
  unit: HostedPricingUnit;
  costMicros: number;
  unitsPerCost: number;
  targetMarginBps: number;
  provider: string;
  model: string;
  effectiveFrom: Date;
};

export type UsageLine = { unit: HostedPricingUnit; units: number };

function ceilDiv(left: bigint, right: bigint) {
  if (right <= BigInt(0)) throw new Error("Pricing divisor must be positive.");
  return (left + right - BigInt(1)) / right;
}

function safeNumber(value: bigint, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds JavaScript safe integer range.`);
  return number;
}

export function quoteHostedUsage(rates: HostedRate[], lines: UsageLine[]) {
  let providerCostMicros = BigInt(0);
  let retailMicros = BigInt(0);
  const billedUnits: Record<string, number> = {};
  const usedRates: HostedRate[] = [];

  for (const line of lines) {
    if (!Number.isSafeInteger(line.units) || line.units < 0) {
      throw new Error("Hosted usage units must be non-negative safe integers.");
    }
    if (line.units === 0) continue;

    const rate = rates.find((candidate) => candidate.unit === line.unit);
    if (!rate) throw new Error(`Missing hosted rate for ${line.unit}.`);
    if (!Number.isSafeInteger(rate.costMicros) || rate.costMicros < 0 || !Number.isSafeInteger(rate.unitsPerCost) || rate.unitsPerCost <= 0) {
      throw new Error(`Invalid hosted rate ${rate.id}.`);
    }
    if (!Number.isInteger(rate.targetMarginBps) || rate.targetMarginBps < 0 || rate.targetMarginBps >= 10_000) {
      throw new Error(`Invalid target margin on hosted rate ${rate.id}.`);
    }

    const cost = ceilDiv(
      BigInt(line.units) * BigInt(rate.costMicros),
      BigInt(rate.unitsPerCost),
    );
    const retail = ceilDiv(
      cost * BigInt(10_000),
      BigInt(10_000 - rate.targetMarginBps),
    );

    providerCostMicros += cost;
    retailMicros += retail;
    billedUnits[line.unit] = (billedUnits[line.unit] ?? 0) + line.units;
    if (!usedRates.some((candidate) => candidate.id === rate.id)) usedRates.push(rate);
  }

  const credits = retailMicros === BigInt(0) ? BigInt(0) : ceilDiv(retailMicros, BigInt(1_000));
  return {
    credits: safeNumber(credits, "Credit charge"),
    providerCostMicros: safeNumber(providerCostMicros, "Provider cost"),
    retailMicros: safeNumber(retailMicros, "Retail value"),
    billedUnits,
    pricingDetails: {
      creditValueMicros: 1_000,
      rates: usedRates.map((rate) => ({
        id: rate.id,
        unit: rate.unit,
        provider: rate.provider,
        model: rate.model,
        costMicros: rate.costMicros,
        unitsPerCost: rate.unitsPerCost,
        targetMarginBps: rate.targetMarginBps,
        effectiveFrom: rate.effectiveFrom.toISOString(),
      })),
    },
  };
}

export async function loadHostedRateSnapshot(input: {
  capability: Capability;
  provider: string;
  model?: string | null;
  units: HostedPricingUnit[];
  at?: Date;
}) {
  const at = input.at ?? new Date();
  const model = input.model?.trim() ?? "";
  const candidates = await db
    .select()
    .from(hostedApiRateCards)
    .where(and(
      eq(hostedApiRateCards.capability, input.capability),
      eq(hostedApiRateCards.provider, input.provider),
      eq(hostedApiRateCards.enabled, true),
      lte(hostedApiRateCards.effectiveFrom, at),
      or(isNull(hostedApiRateCards.effectiveTo), gt(hostedApiRateCards.effectiveTo, at)),
      or(eq(hostedApiRateCards.model, model), eq(hostedApiRateCards.model, "")),
    ))
    .orderBy(desc(hostedApiRateCards.effectiveFrom));

  return input.units.map((unit) => {
    const exact = candidates.find((row) => row.unit === unit && row.model === model);
    const fallback = candidates.find((row) => row.unit === unit && row.model === "");
    const row = exact ?? fallback;
    if (!row) {
      throw new AppError(
        "HOSTED_RATE_NOT_CONFIGURED",
        `Hosted pricing is not configured for ${input.provider} ${model || input.capability} ${unit}.`,
        503,
      );
    }
    return {
      id: row.id,
      unit: row.unit as HostedPricingUnit,
      costMicros: row.costMicros,
      unitsPerCost: row.unitsPerCost,
      targetMarginBps: row.targetMarginBps,
      provider: row.provider,
      model: row.model,
      effectiveFrom: row.effectiveFrom,
    } satisfies HostedRate;
  });
}
