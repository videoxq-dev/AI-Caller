import { describe, expect, it } from "vitest";
import { creditsForCarrierCost, quoteHostedPhoneNumber, usdDecimalToMicros } from "./pricing";

describe("hosted phone number pricing", () => {
  it("parses carrier USD costs without floating-point drift", () => {
    expect(usdDecimalToMicros("1.10")).toBe(1_100_000);
    expect(usdDecimalToMicros("0.0052")).toBe(5_200);
  });

  it("applies a true 50% gross margin to carrier cost", () => {
    expect(creditsForCarrierCost(1_100_000, 5000)).toBe(2200);
  });

  it("quotes purchase as upfront plus first month and renewal as monthly only", () => {
    expect(quoteHostedPhoneNumber({ monthlyCost: "1.10", upfrontCost: "0.50", currency: "USD" })).toEqual({
      monthlyCostMicros: 1_100_000,
      upfrontCostMicros: 500_000,
      monthlyCredits: 2200,
      purchaseCredits: 3200,
    });
  });
});
