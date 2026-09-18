import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { contactIdentities, contacts, workspaces } from "@/db/schema";
import { getOrCreateContactByIdentity } from "@/server/domain/core/repository";
import { resolveVoiceContact } from "./identity";

describe("voice contact identity resolution", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Voice Identity Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("attaches PHONE to an existing SMS contact with the same normalized number", async () => {
    const smsContact = await getOrCreateContactByIdentity(workspaceId, {
      channel: "SMS",
      externalId: "+1 (555) 123-4567",
      name: "Existing Customer",
    });

    const voiceContact = await resolveVoiceContact(workspaceId, "15551234567");

    expect(voiceContact.id).toBe(smsContact.id);
    expect(await db.select().from(contacts)).toHaveLength(1);
    const identities = await db.select().from(contactIdentities);
    expect(identities.map((identity) => identity.channel).sort()).toEqual(["PHONE", "SMS"]);
  });

  it("does not merge when the same number is already ambiguous across contacts", async () => {
    const [first, second] = await db.insert(contacts).values([
      { workspaceId, name: "First", phone: "+15550001111" },
      { workspaceId, name: "Second", phone: "+15550001111" },
    ]).returning();
    await db.insert(contactIdentities).values([
      { workspaceId, contactId: first.id, channel: "SMS", externalId: "+15550001111", normalizedValue: "+15550001111" },
      { workspaceId, contactId: second.id, channel: "WHATSAPP", externalId: "15550001111", normalizedValue: "+15550001111" },
    ]);

    const voiceContact = await resolveVoiceContact(workspaceId, "+15550001111");

    expect(voiceContact.id).not.toBe(first.id);
    expect(voiceContact.id).not.toBe(second.id);
    expect(await db.select().from(contacts)).toHaveLength(3);
  });
});
