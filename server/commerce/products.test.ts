import { describe, expect, it } from "vitest";
import { FUNNEL_PRODUCTS, getAgencyClientLimit, getPurchasedBusinessLimit, resolveFunnelProductId, type FunnelProductConfiguration } from "./products";

const configuration: FunnelProductConfiguration = {
  JVZOO_CORE_PRODUCT_IDS: " core-1,core-2 ",
  JVZOO_UNLIMITED_PRODUCT_IDS: "unlimited-1",
  JVZOO_PERFORMANCE_PRODUCT_IDS: "performance-1",
  JVZOO_AGENCY_50_PRODUCT_IDS: "agency-50",
  JVZOO_AGENCY_100_PRODUCT_IDS: "agency-100",
  JVZOO_WHITELABEL_PRODUCT_IDS: "whitelabel-1",
};

describe("Assistlia commercial funnel product mapping", () => {
  it("recognizes all five offers, including both Agency capacity SKUs", () => {
    expect(FUNNEL_PRODUCTS.map(({ code }) => code)).toEqual([
      "CORE", "UNLIMITED", "PERFORMANCE", "AGENCY_50", "AGENCY_100", "WHITELABEL",
    ]);
    expect(resolveFunnelProductId("core-1", configuration)).toBe("CORE");
    expect(resolveFunnelProductId("core-2", configuration)).toBe("CORE");
    expect(resolveFunnelProductId("unlimited-1", configuration)).toBe("UNLIMITED");
    expect(resolveFunnelProductId("performance-1", configuration)).toBe("PERFORMANCE");
    expect(resolveFunnelProductId("agency-50", configuration)).toBe("AGENCY_50");
    expect(resolveFunnelProductId("agency-100", configuration)).toBe("AGENCY_100");
    expect(resolveFunnelProductId("whitelabel-1", configuration)).toBe("WHITELABEL");
  });

  it("does not grant Core or any other product for an unknown ID", () => {
    expect(resolveFunnelProductId("not-configured", configuration)).toBeNull();
    expect(resolveFunnelProductId("", configuration)).toBeNull();
  });

  it("fails closed when no JVZoo IDs are configured", () => {
    const empty = Object.fromEntries(
      FUNNEL_PRODUCTS.map(({ envKey }) => [envKey, ""]),
    ) as FunnelProductConfiguration;
    expect(resolveFunnelProductId("any-product", empty)).toBeNull();
  });

  it("rejects conflicting IDs even when the incoming ID does not match them", () => {
    expect(() => resolveFunnelProductId("unrelated", {
      ...configuration,
      JVZOO_UNLIMITED_PRODUCT_IDS: "core-2",
    })).toThrow("configured for multiple funnel SKUs");
  });

  it("permits repeated IDs within the same SKU but not between SKUs", () => {
    expect(resolveFunnelProductId("core-1", {
      ...configuration,
      JVZOO_CORE_PRODUCT_IDS: "core-1, core-1",
    })).toBe("CORE");
  });

  it("records the approved funnel limits without confusing credits with unlimited usage", () => {
    expect(FUNNEL_PRODUCTS.find(({ code }) => code === "CORE")).toMatchObject({
      businessLimit: 1, purchaseCredits: 15_000,
    });
    expect(FUNNEL_PRODUCTS.find(({ code }) => code === "UNLIMITED")).toMatchObject({
      businessLimit: 2, purchaseCredits: 15_000,
    });
    expect(FUNNEL_PRODUCTS.filter(({ offer }) => offer === "AGENCY").map(({ businessLimit }) => businessLimit)).toEqual([50, 100]);
    expect(getPurchasedBusinessLimit(["UNLIMITED"])).toBe(2);
    expect(getAgencyClientLimit(["CORE", "AGENCY_50"])).toBe(50);
    expect(getPurchasedBusinessLimit(["CORE", "AGENCY_50"])).toBe(51);
    expect(getPurchasedBusinessLimit(["AGENCY_100"])).toBe(101);
    expect(getAgencyClientLimit(["AGENCY_50", "AGENCY_100"])).toBe(150);
    expect(getPurchasedBusinessLimit(["AGENCY_50", "AGENCY_100"])).toBe(151);
    expect(getAgencyClientLimit(["AGENCY_50", "AGENCY_50"])).toBe(100);
    expect(getPurchasedBusinessLimit(["AGENCY_50", "AGENCY_50"])).toBe(101);
    expect(getAgencyClientLimit(["CORE", "UNLIMITED"])).toBeNull();
  });
});
