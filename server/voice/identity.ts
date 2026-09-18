import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { contactIdentities, contacts } from "@/db/schema";
import { findContactByIdentity, getOrCreateContactByIdentity } from "@/server/domain/core/repository";
import { contactIdentityInputSchema } from "@/server/domain/core/schemas";

const PHONE_IDENTITY_CHANNELS = ["PHONE", "SMS", "WHATSAPP"] as const;

export async function resolveVoiceContact(workspaceId: string, externalId: string) {
  const identity = contactIdentityInputSchema.parse({ channel: "PHONE", externalId });
  const existing = await findContactByIdentity(workspaceId, "PHONE", externalId);
  if (existing) return existing;

  const [identityMatches, phoneMatches] = await Promise.all([
    db.select({ contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(and(
        eq(contactIdentities.workspaceId, workspaceId),
        inArray(contactIdentities.channel, PHONE_IDENTITY_CHANNELS),
        eq(contactIdentities.normalizedValue, identity.normalizedValue),
      ))
      .limit(3),
    db.select({ contactId: contacts.id })
      .from(contacts)
      .where(and(
        eq(contacts.workspaceId, workspaceId),
        eq(contacts.phone, identity.normalizedValue),
      ))
      .limit(3),
  ]);

  const contactIds = [...new Set([...identityMatches, ...phoneMatches].map((match) => match.contactId))];
  if (contactIds.length === 1) {
    await db.insert(contactIdentities).values({
      workspaceId,
      contactId: contactIds[0],
      channel: "PHONE",
      externalId: identity.externalId,
      normalizedValue: identity.normalizedValue,
    }).onConflictDoNothing();

    const linked = await findContactByIdentity(workspaceId, "PHONE", externalId);
    if (linked) return linked;
  }

  return getOrCreateContactByIdentity(workspaceId, {
    channel: "PHONE",
    externalId,
  });
}
