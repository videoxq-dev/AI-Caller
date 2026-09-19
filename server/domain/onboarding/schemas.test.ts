import { describe, expect, it } from "vitest";
import { businessProfileInputSchema } from "./schemas";

function validBusiness() {
  return {
    businessName: "Acme",
    industry: "Home services",
    websiteUrl: "https://example.com",
    timezone: "America/New_York",
    hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      enabled: dayOfWeek < 5,
      openTime: dayOfWeek < 5 ? "08:00" : null,
      closeTime: dayOfWeek < 5 ? "18:00" : null,
    })),
    completeStep: false,
  };
}

describe("business profile validation", () => {
  it("accepts IANA timezones and complete hourly schedules", () => {
    expect(businessProfileInputSchema.safeParse(validBusiness()).success).toBe(true);
  });

  it("rejects invalid timezones", () => {
    expect(businessProfileInputSchema.safeParse({ ...validBusiness(), timezone: "Not/AZone" }).success).toBe(false);
  });

  it("requires valid opening and closing times on enabled days", () => {
    const input = validBusiness();
    input.hours[0] = { dayOfWeek: 0, enabled: true, openTime: null, closeTime: null };
    expect(businessProfileInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects the legacy display-string time format on new writes", () => {
    const input = validBusiness();
    input.hours[1] = { dayOfWeek: 1, enabled: true, openTime: "8:00 AM", closeTime: "6:00 PM" };
    expect(businessProfileInputSchema.safeParse(input).success).toBe(false);
  });
});
