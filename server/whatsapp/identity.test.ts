import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { contactIdentities, contacts, workspaces } from "@/db/schema";
import { getOrCreateContactByIdentity } from "@/server/domain/core/repository";
import { resolveWhatsAppContact } from "./identity";

describe("WhatsApp contact identity resolution", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "WhatsApp Identity Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("attaches WhatsApp to the existing SMS contact with the same normalized phone", async () => {
    const smsContact = await getOrCreateContactByIdentity(workspaceId, {
      channel: "SMS",
      externalId: "+1 (555) 123-4567",
      name: "Existing Customer",
    });

    const whatsappContact = await resolveWhatsAppContact(workspaceId, "15551234567", "Meta Profile");

    expect(whatsappContact.id).toBe(smsContact.id);
    expect(await db.select().from(contacts)).toHaveLength(1);
    const identities = await db.select().from(contactIdentities);
    expect(identities.map((identity) => identity.channel).sort()).toEqual(["SMS", "WHATSAPP"]);
    expect(new Set(identities.map((identity) => identity.normalizedValue))).toEqual(new Set(["+15551234567"]));
  });

  it("creates a new contact when no existing phone match is available", async () => {
    const contact = await resolveWhatsAppContact(workspaceId, "15559876543", "New WhatsApp Customer");

    expect(contact).toMatchObject({ name: "New WhatsApp Customer", phone: "+15559876543" });
    const identities = await db.select().from(contactIdentities);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ contactId: contact.id, channel: "WHATSAPP", normalizedValue: "+15559876543" });
  });
});
