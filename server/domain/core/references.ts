import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, conversations, services } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import type { AppointmentInput } from "./schemas";

export async function assertAppointmentReferences(workspaceId: string, input: AppointmentInput) {
  const [contact] = await db.select({ id: contacts.id }).from(contacts).where(and(
    eq(contacts.workspaceId, workspaceId),
    eq(contacts.id, input.contactId),
  )).limit(1);
  if (!contact) throw new AppError("CONTACT_NOT_FOUND", "Contact not found.", 404);

  if (input.conversationId) {
    const [conversation] = await db.select({ id: conversations.id }).from(conversations).where(and(
      eq(conversations.workspaceId, workspaceId),
      eq(conversations.id, input.conversationId),
      eq(conversations.contactId, input.contactId),
    )).limit(1);
    if (!conversation) {
      throw new AppError("INVALID_CONVERSATION", "The conversation does not belong to this contact and workspace.", 422);
    }
  }

  if (input.serviceId) {
    const [service] = await db.select({ id: services.id }).from(services).where(and(
      eq(services.workspaceId, workspaceId),
      eq(services.id, input.serviceId),
    )).limit(1);
    if (!service) throw new AppError("SERVICE_NOT_FOUND", "Service not found.", 404);
  }
}
