import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contactIdentities, contacts } from "@/db/schema";
import {
  findContactByIdentity,
  getOrCreateContactByIdentity,
} from "@/server/domain/core/repository";
import { contactIdentityInputSchema } from "@/server/domain/core/schemas";

export async function resolveWhatsAppContact(
  workspaceId: string,
  externalId: string,
  profileName: string | null,
) {
  const identity = contactIdentityInputSchema.parse({ channel: "WHATSAPP", externalId });
  const existing = await findContactByIdentity(workspaceId, "WHATSAPP", externalId);
  if (existing) return existing;

  const phoneMatches = await db.select({ id: contacts.id })
    .from(contacts)
    .where(and(
      eq(contacts.workspaceId, workspaceId),
      eq(contacts.phone, identity.normalizedValue),
    ))
    .limit(2);

  if (phoneMatches.length === 1) {
    await db.insert(contactIdentities).values({
      workspaceId,
      contactId: phoneMatches[0].id,
      channel: "WHATSAPP",
      externalId: identity.externalId,
      normalizedValue: identity.normalizedValue,
    }).onConflictDoNothing();

    const linked = await findContactByIdentity(workspaceId, "WHATSAPP", externalId);
    if (linked) return linked;
  }

  return getOrCreateContactByIdentity(workspaceId, {
    channel: "WHATSAPP",
    externalId,
    name: profileName,
  });
}
