import { describe, expect, it } from "vitest";
import {
  appointmentInputSchema,
  contactInputSchema,
  handlingModeInputSchema,
  messageInputSchema,
} from "./schemas";

describe("core domain schemas", () => {
  it("normalizes contact fields, tags and identities", () => {
    const result = contactInputSchema.parse({
      name: "  Ada Lovelace  ",
      email: " ADA@example.com ",
      phone: " +1 (555) 123-4567 ",
      tags: [" VIP ", "vip", " New lead "],
      identities: [
        { channel: "SMS", externalId: " +1 (555) 123-4567 " },
        { channel: "WHATSAPP", externalId: "15551234567" },
      ],
    });

    expect(result.name).toBe("Ada Lovelace");
    expect(result.email).toBe("ada@example.com");
    expect(result.phone).toBe("+15551234567");
    expect(result.tags).toEqual(["VIP", "New lead"]);
    expect(result.identities).toEqual([
      { channel: "SMS", externalId: "+1 (555) 123-4567", normalizedValue: "+15551234567" },
      { channel: "WHATSAPP", externalId: "15551234567", normalizedValue: "+15551234567" },
    ]);
  });

  it("rejects appointments whose end is not after their start", () => {
    const result = appointmentInputSchema.safeParse({
      contactId: "11111111-1111-4111-8111-111111111111",
      title: "Consultation",
      startsAt: "2026-09-20T15:00:00.000Z",
      endsAt: "2026-09-20T14:30:00.000Z",
      timezone: "America/New_York",
    });

    expect(result.success).toBe(false);
  });

  it("requires message content and explicit channel semantics", () => {
    const result = messageInputSchema.parse({
      channel: "WEBCHAT",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      body: "Can I book Friday?",
    });

    expect(result.contentType).toBe("TEXT");
    expect(result.body).toBe("Can I book Friday?");
  });

  it("accepts human takeover and return-to-AI modes", () => {
    expect(handlingModeInputSchema.parse({ mode: "HUMAN" })).toEqual({ mode: "HUMAN" });
    expect(handlingModeInputSchema.parse({ mode: "AI" })).toEqual({ mode: "AI" });
  });
});
