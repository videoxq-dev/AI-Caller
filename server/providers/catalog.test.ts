import { describe, expect, it } from "vitest";
import { capabilitiesForProvider, providerSupportsCapability } from "./catalog";

describe("provider capability catalog", () => {
  it("keeps provider families constrained to their supported capabilities", () => {
    expect(providerSupportsCapability("openai", "AI_TEXT")).toBe(true);
    expect(providerSupportsCapability("openai", "SMS")).toBe(false);
    expect(providerSupportsCapability("telnyx", "SMS")).toBe(true);
    expect(providerSupportsCapability("telnyx", "VOICE")).toBe(true);
    expect(providerSupportsCapability("telnyx", "WHATSAPP")).toBe(false);
    expect(providerSupportsCapability("whatsapp", "WHATSAPP")).toBe(true);
    expect(providerSupportsCapability("calendly", "CALENDAR")).toBe(true);
  });

  it("returns no capabilities for unknown providers", () => {
    expect(capabilitiesForProvider("unknown")).toEqual([]);
  });
});
