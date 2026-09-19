import { getEnv } from "@/server/env";

const MICROS_PER_CREDIT = 1_000;

export function usdDecimalToMicros(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) throw new Error("Invalid USD carrier cost.");
  const [whole, fraction = ""] = normalized.split(".");
  const micros = BigInt(whole) * BigInt(1_000_000) + BigInt((fraction + "000000").slice(0, 6));
  const result = Number(micros);
  if (!Number.isSafeInteger(result)) throw new Error("Carrier cost is too large.");
  return result;
}

function ceilDiv(left: bigint, right: bigint) {
  return (left + right - BigInt(1)) / right;
}

export function creditsForCarrierCost(costMicros: number, marginBps = getEnv().HOSTED_TELEPHONY_TARGET_MARGIN_BPS) {
  if (!Number.isSafeInteger(costMicros) || costMicros < 0) throw new Error("Carrier cost must be a non-negative integer.");
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps >= 10_000) throw new Error("Telephony margin is invalid.");
  if (costMicros === 0) return 0;
  const retailMicros = ceilDiv(BigInt(costMicros) * BigInt(10_000), BigInt(10_000 - marginBps));
  return Number(ceilDiv(retailMicros, BigInt(MICROS_PER_CREDIT)));
}

export function quoteHostedPhoneNumber(input: { monthlyCost: string; upfrontCost: string; currency: string }) {
  if (input.currency.toUpperCase() !== "USD") throw new Error("Only USD-priced phone numbers are supported during this MVP.");
  const monthlyCostMicros = usdDecimalToMicros(input.monthlyCost);
  const upfrontCostMicros = usdDecimalToMicros(input.upfrontCost);
  const monthlyCredits = creditsForCarrierCost(monthlyCostMicros);
  const purchaseCredits = creditsForCarrierCost(monthlyCostMicros + upfrontCostMicros);
  return { monthlyCostMicros, upfrontCostMicros, monthlyCredits, purchaseCredits };
}
