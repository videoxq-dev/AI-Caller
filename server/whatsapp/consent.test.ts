import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { whatsappConsentEvents, workspaces } from "@/db/schema";
import { getOrCreateContactByIdentity } from "@/server/domain/core/repository";
import {
  getWhatsAppConsentStatus, recordWhatsAppConsent, validWhatsAppId,
  whatsappPreferenceKeyword,
} from "./consent";

describe("WhatsApp channel-specific permission", () => {
  let workspaceId = "";
  let contactId = "";
  const waId = "15551234567";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "WhatsApp permissions" }).returning();
    workspaceId = workspace.id;
    const contact = await getOrCreateContactByIdentity(workspaceId, {
      channel: "WHATSAPP", externalId: waId,
    });
    contactId = contact.id;
  });
  afterAll(async () => { await closeDatabase(); });

  it("requires a verified WhatsApp identity and does not import SMS consent", async () => {
    expect(await getWhatsAppConsentStatus(workspaceId, waId, "UTILITY")).toBe("UNKNOWN");
    await expect(recordWhatsAppConsent({
      workspaceId, contactId, waId: "15551230000", category: "MARKETING",
      status: "OPTED_IN", source: "STAFF_ENTRY",
    })).rejects.toMatchObject({ code: "WHATSAPP_IDENTITY_NOT_FOUND" });
    expect(validWhatsAppId("+15551234567")).toBe("15551234567");
    expect(() => validWhatsAppId("++15551234567")).toThrow();
    expect(await db.select().from(whatsappConsentEvents)).toHaveLength(0);
  });

  it("preserves utility and marketing preferences independently with append-only evidence", async () => {
    const save = (category: "UTILITY" | "MARKETING", status: "OPTED_IN" | "OPTED_OUT") =>
      recordWhatsAppConsent({ workspaceId, contactId, waId, category, status,
        source: "INBOUND_WHATSAPP", sourceReference: "wamid.permission" });
    await save("UTILITY", "OPTED_IN");
    await save("MARKETING", "OPTED_IN");
    await save("UTILITY", "OPTED_OUT");
    expect(await getWhatsAppConsentStatus(workspaceId, waId, "UTILITY")).toBe("OPTED_OUT");
    expect(await getWhatsAppConsentStatus(workspaceId, waId, "MARKETING")).toBe("OPTED_IN");
    expect(await db.select().from(whatsappConsentEvents)).toHaveLength(3);
    const [other] = await db.insert(workspaces).values({ name: "Other" }).returning();
    expect(await getWhatsAppConsentStatus(other.id, waId, "MARKETING")).toBe("UNKNOWN");
  });

  it("recognizes explicit opt-outs without treating ordinary speech as a command", () => {
    expect(whatsappPreferenceKeyword("STOP!")).toBe("STOP");
    expect(whatsappPreferenceKeyword("unsubscribe")).toBe("STOP");
    expect(whatsappPreferenceKeyword("START")).toBe("START");
    expect(whatsappPreferenceKeyword("Can you stop by Tuesday?")).toBeNull();
  });
});
