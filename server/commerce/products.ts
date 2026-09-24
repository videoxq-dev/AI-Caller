import type { AppEnv } from "@/server/env";
import { getEnv } from "@/server/env";

// Commercial funnel SKUs are distinct from the legacy PERSONAL/GROWTH workspace seat plans.
// Agency has two purchasable capacities within the same Agency offer.
export const FUNNEL_PRODUCTS = [
  { code: "CORE", offer: "CORE", envKey: "JVZOO_CORE_PRODUCT_IDS", businessLimit: 1, purchaseCredits: 15_000 },
  { code: "UNLIMITED", offer: "UNLIMITED", envKey: "JVZOO_UNLIMITED_PRODUCT_IDS", businessLimit: 2, purchaseCredits: 15_000 },
  { code: "PERFORMANCE", offer: "PERFORMANCE", envKey: "JVZOO_PERFORMANCE_PRODUCT_IDS", businessLimit: null, purchaseCredits: 0 },
  { code: "AGENCY_50", offer: "AGENCY", envKey: "JVZOO_AGENCY_50_PRODUCT_IDS", businessLimit: 50, purchaseCredits: 0 },
  { code: "AGENCY_100", offer: "AGENCY", envKey: "JVZOO_AGENCY_100_PRODUCT_IDS", businessLimit: 100, purchaseCredits: 0 },
  { code: "WHITELABEL", offer: "WHITELABEL", envKey: "JVZOO_WHITELABEL_PRODUCT_IDS", businessLimit: null, purchaseCredits: 0 },
] as const;

export type FunnelProductCode = (typeof FUNNEL_PRODUCTS)[number]["code"];
export type FunnelOffer = (typeof FUNNEL_PRODUCTS)[number]["offer"];
export type FunnelProductConfiguration = Pick<AppEnv, (typeof FUNNEL_PRODUCTS)[number]["envKey"]>;

/**
 * Fail closed on unknown and unconfigured product IDs. Never infer a product
 * from its title, transaction amount, or the absence of configuration.
 *
 * Throws for conflicting mappings rather than silently awarding the first
 * matching SKU. This validation applies even if the incoming ID is unrelated.
 */
export function resolveFunnelProductId(
  productId: string,
  configuration: FunnelProductConfiguration = getEnv(),
): FunnelProductCode | null {
  const assigned = new Map<string, FunnelProductCode>();
  for (const product of FUNNEL_PRODUCTS) {
    for (const rawId of configuration[product.envKey].split(",")) {
      const id = rawId.trim();
      if (!id) continue;
      const previous = assigned.get(id);
      if (previous && previous !== product.code) {
        throw new Error("JVZoo product ID is configured for multiple funnel SKUs.");
      }
      assigned.set(id, product.code);
    }
  }
  return assigned.get(productId.trim()) ?? null;
}

/** Agency capacity is a client allowance, excluding the buyer's original business. */
export function getAgencyClientLimit(activeCodes: readonly string[]): number | null {
  const limit = Math.max(0, ...FUNNEL_PRODUCTS
    .filter((product) => product.offer === "AGENCY" && activeCodes.includes(product.code))
    .map((product) => product.businessLimit ?? 0));
  return limit > 0 ? limit : null;
}

/** Total owned-business capacity; Agency client slots are in addition to the original business. */
export function getPurchasedBusinessLimit(activeCodes: readonly string[]): number {
  const standardLimit = Math.max(0, ...FUNNEL_PRODUCTS
    .filter((product) => product.offer !== "AGENCY" && activeCodes.includes(product.code))
    .map((product) => product.businessLimit ?? 0));
  const agencyClients = getAgencyClientLimit(activeCodes);
  return Math.max(standardLimit, agencyClients === null ? 0 : agencyClients + 1);
}
