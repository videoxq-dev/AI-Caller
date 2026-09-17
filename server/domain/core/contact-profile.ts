import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { AppError } from "@/server/http/errors";

export async function updateContactProfile(
  workspaceId: string,
  contactId: string,
  input: { name?: string; email?: string; phone?: string },
) {
  const updates: Partial<typeof contacts.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.email !== undefined) updates.email = input.email;
  if (input.phone !== undefined) updates.phone = input.phone;

  const [contact] = await db.update(contacts)
    .set(updates)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, contactId)))
    .returning();
  if (!contact) throw new AppError("CONTACT_NOT_FOUND", "Contact not found.", 404);
  return contact;
}
