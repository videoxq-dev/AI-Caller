import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  lt,
  gt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import {
  appointments,
  automationEvents,
  bookingReservations,
  contactIdentities,
  contacts,
  contactTags,
  conversations,
  leads,
  messages,
} from "@/db/schema";
import { AppError } from "@/server/http/errors";
import {
  contactIdentityInputSchema,
  type AppointmentInput,
  type AppointmentRescheduleInput,
  type ContactInput,
  type LeadInput,
  type MessageInput,
} from "./schemas";
import type { NativeBookingPolicy } from "./native-calendar";

type ContactListOptions = {
  query?: string;
  status?: "NEW" | "QUALIFIED" | "BOOKED" | "WON" | "LOST";
  channel?: "PHONE" | "SMS" | "WHATSAPP" | "WEBCHAT";
  limit?: number;
  offset?: number;
};

type AppointmentListOptions = {
  status?: "PENDING" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
};

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error as { code?: string }).code === "23505") return true;
  return "cause" in error && isUniqueViolation((error as { cause?: unknown }).cause);
}

async function ensureContactInWorkspace(workspaceId: string, contactId: string) {
  const [contact] = await db.select().from(contacts).where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, contactId))).limit(1);
  if (!contact) throw new AppError("CONTACT_NOT_FOUND", "Contact not found.", 404);
  return contact;
}

export async function createContact(workspaceId: string, input: ContactInput) {
  return db.transaction(async (tx) => {
    const [contact] = await tx.insert(contacts).values({
      workspaceId,
      name: input.name ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      notes: input.notes ?? null,
    }).returning();

    if (input.identities.length) {
      await tx.insert(contactIdentities).values(input.identities.map((identity) => ({
        workspaceId,
        contactId: contact.id,
        channel: identity.channel,
        externalId: identity.externalId,
        normalizedValue: identity.normalizedValue,
      })));
    }

    if (input.tags.length) {
      await tx.insert(contactTags).values(input.tags.map((tag) => ({ contactId: contact.id, tag })));
    }

    return contact;
  });
}

export async function updateContact(workspaceId: string, contactId: string, input: ContactInput) {
  return db.transaction(async (tx) => {
    const [contact] = await tx.update(contacts).set({
      name: input.name ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      notes: input.notes ?? null,
      updatedAt: new Date(),
    }).where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, contactId))).returning();

    if (!contact) throw new AppError("CONTACT_NOT_FOUND", "Contact not found.", 404);

    await tx.delete(contactTags).where(eq(contactTags.contactId, contactId));
    if (input.tags.length) {
      await tx.insert(contactTags).values(input.tags.map((tag) => ({ contactId, tag })));
    }

    await tx.delete(contactIdentities).where(and(eq(contactIdentities.workspaceId, workspaceId), eq(contactIdentities.contactId, contactId)));
    if (input.identities.length) {
      await tx.insert(contactIdentities).values(input.identities.map((identity) => ({
        workspaceId,
        contactId,
        channel: identity.channel,
        externalId: identity.externalId,
        normalizedValue: identity.normalizedValue,
      })));
    }

    return contact;
  });
}

export async function listContacts(workspaceId: string, options: ContactListOptions = {}) {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const conditions: SQL[] = [eq(contacts.workspaceId, workspaceId)];

  if (options.query) {
    const pattern = `%${options.query}%`;
    conditions.push(or(
      ilike(contacts.name, pattern),
      ilike(contacts.email, pattern),
      ilike(contacts.phone, pattern),
    )!);
  }
  if (options.status) conditions.push(eq(leads.status, options.status));
  if (options.channel) {
    const identityContactIds = db.select({ contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(and(eq(contactIdentities.workspaceId, workspaceId), eq(contactIdentities.channel, options.channel)));
    conditions.push(inArray(contacts.id, identityContactIds));
  }

  const rows = await db.select({
    contact: contacts,
    lead: leads,
  }).from(contacts)
    .leftJoin(leads, and(eq(leads.workspaceId, workspaceId), eq(leads.contactId, contacts.id)))
    .where(and(...conditions))
    .orderBy(desc(contacts.updatedAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(contacts)
    .leftJoin(leads, and(eq(leads.workspaceId, workspaceId), eq(leads.contactId, contacts.id)))
    .where(and(...conditions));

  const ids = rows.map((row) => row.contact.id);
  if (!ids.length) return { items: [], total: count, limit, offset };

  const [identityRows, tagRows] = await Promise.all([
    db.select().from(contactIdentities).where(and(eq(contactIdentities.workspaceId, workspaceId), inArray(contactIdentities.contactId, ids))),
    db.select().from(contactTags).where(inArray(contactTags.contactId, ids)),
  ]);

  const identitiesByContact = new Map<string, typeof identityRows>();
  for (const identity of identityRows) {
    const values = identitiesByContact.get(identity.contactId) ?? [];
    values.push(identity);
    identitiesByContact.set(identity.contactId, values);
  }
  const tagsByContact = new Map<string, string[]>();
  for (const tag of tagRows) {
    const values = tagsByContact.get(tag.contactId) ?? [];
    values.push(tag.tag);
    tagsByContact.set(tag.contactId, values);
  }

  return {
    items: rows.map((row) => ({
      ...row.contact,
      lead: row.lead,
      identities: identitiesByContact.get(row.contact.id) ?? [],
      tags: tagsByContact.get(row.contact.id) ?? [],
    })),
    total: count,
    limit,
    offset,
  };
}

export async function getContactDetail(workspaceId: string, contactId: string) {
  const [contact] = await db.select().from(contacts).where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, contactId))).limit(1);
  if (!contact) return null;

  const [identities, tags, lead, contactAppointments] = await Promise.all([
    db.select().from(contactIdentities).where(and(eq(contactIdentities.workspaceId, workspaceId), eq(contactIdentities.contactId, contactId))).orderBy(asc(contactIdentities.createdAt)),
    db.select().from(contactTags).where(eq(contactTags.contactId, contactId)).orderBy(asc(contactTags.tag)),
    db.select().from(leads).where(and(eq(leads.workspaceId, workspaceId), eq(leads.contactId, contactId))).limit(1).then((rows) => rows[0] ?? null),
    db.select().from(appointments).where(and(eq(appointments.workspaceId, workspaceId), eq(appointments.contactId, contactId))).orderBy(desc(appointments.startsAt)).limit(20),
  ]);

  return {
    ...contact,
    identities,
    tags: tags.map((tag) => tag.tag),
    lead,
    appointments: contactAppointments,
  };
}

export async function findContactByIdentity(workspaceId: string, channel: "PHONE" | "SMS" | "WHATSAPP" | "WEBCHAT", externalId: string) {
  const identity = contactIdentityInputSchema.parse({ channel, externalId });
  const [row] = await db.select({ contact: contacts })
    .from(contactIdentities)
    .innerJoin(contacts, and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, contactIdentities.contactId)))
    .where(and(
      eq(contactIdentities.workspaceId, workspaceId),
      eq(contactIdentities.channel, channel),
      eq(contactIdentities.normalizedValue, identity.normalizedValue),
    ))
    .limit(1);
  return row?.contact ?? null;
}

export async function getOrCreateContactByIdentity(
  workspaceId: string,
  input: { channel: "PHONE" | "SMS" | "WHATSAPP" | "WEBCHAT"; externalId: string; name?: string | null; email?: string | null },
) {
  const identity = contactIdentityInputSchema.parse(input);
  const existing = await findContactByIdentity(workspaceId, input.channel, input.externalId);
  if (existing) return existing;

  try {
    return await createContact(workspaceId, {
      name: input.name ?? null,
      email: input.email?.trim().toLowerCase() ?? null,
      phone: input.channel === "WEBCHAT" ? null : identity.normalizedValue,
      notes: null,
      tags: [],
      identities: [identity],
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findContactByIdentity(workspaceId, input.channel, input.externalId);
    if (raced) return raced;
    throw error;
  }
}

export async function upsertLead(workspaceId: string, contactId: string, input: LeadInput) {
  await ensureContactInWorkspace(workspaceId, contactId);
  return db.transaction(async (tx) => {
    const [before] = await tx.select({ id: leads.id, status: leads.status }).from(leads).where(and(
      eq(leads.workspaceId, workspaceId),
      eq(leads.contactId, contactId),
    )).limit(1);
    const now = new Date();
    const [lead] = await tx.insert(leads).values({
      workspaceId,
      contactId,
      status: input.status,
      intent: input.intent ?? null,
      serviceRequested: input.serviceRequested ?? null,
      source: input.source ?? null,
      estimatedValue: input.estimatedValue ?? null,
      qualificationData: input.qualificationData ?? {},
      qualificationScore: input.qualificationScore ?? 0,
      qualificationCompletedAt: input.qualificationCompletedAt ?? null,
      assignedUserId: input.assignedUserId ?? null,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [leads.workspaceId, leads.contactId],
      set: {
        status: input.status,
        intent: input.intent ?? null,
        serviceRequested: input.serviceRequested ?? null,
        source: input.source ?? null,
        estimatedValue: input.estimatedValue ?? null,
        ...(input.qualificationData !== undefined ? { qualificationData: input.qualificationData } : {}),
        ...(input.qualificationScore !== undefined ? { qualificationScore: input.qualificationScore } : {}),
        ...(input.qualificationCompletedAt !== undefined ? { qualificationCompletedAt: input.qualificationCompletedAt } : {}),
        assignedUserId: input.assignedUserId ?? null,
        updatedAt: now,
      },
    }).returning();

    if (lead.status === "QUALIFIED" && before?.status !== "QUALIFIED") {
      await tx.insert(automationEvents).values({
        workspaceId,
        type: "LEAD_QUALIFIED",
        aggregateType: "LEAD",
        aggregateId: lead.id,
        payload: {
          leadId: lead.id,
          contactId,
          qualificationScore: lead.qualificationScore,
        },
        occurredAt: lead.qualificationCompletedAt ?? now,
      }).onConflictDoNothing();
    }

    return lead;
  });
}

export async function getOrCreateOpenConversation(workspaceId: string, contactId: string) {
  await ensureContactInWorkspace(workspaceId, contactId);
  const findOpen = () => db.select().from(conversations).where(and(
    eq(conversations.workspaceId, workspaceId),
    eq(conversations.contactId, contactId),
    eq(conversations.status, "OPEN"),
  )).limit(1).then((rows) => rows[0] ?? null);

  const existing = await findOpen();
  if (existing) return existing;

  const [created] = await db.insert(conversations)
    .values({ workspaceId, contactId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const raced = await findOpen();
  if (raced) return raced;
  throw new AppError("CONVERSATION_CONFLICT", "The open conversation could not be resolved after a concurrent insert.", 409);
}

export async function appendMessage(workspaceId: string, conversationId: string, input: MessageInput) {
  return db.transaction(async (tx) => {
    const [conversation] = await tx.select().from(conversations).where(and(
      eq(conversations.workspaceId, workspaceId),
      eq(conversations.id, conversationId),
    )).limit(1);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);

    const now = new Date();
    const [inserted] = await tx.insert(messages).values({
      workspaceId,
      conversationId,
      channel: input.channel,
      direction: input.direction,
      senderType: input.senderType,
      contentType: input.contentType,
      body: input.body,
      provider: input.provider ?? null,
      externalMessageId: input.externalMessageId ?? null,
      status: input.status ?? null,
      metadata: input.metadata,
      createdAt: now,
    }).onConflictDoNothing().returning();

    if (inserted) {
      await tx.update(conversations).set({ lastMessageAt: now, updatedAt: now })
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)));
      if (inserted.direction === "INBOUND" && inserted.senderType === "CUSTOMER" && inserted.contentType === "TEXT") {
        await tx.insert(automationEvents).values({
          workspaceId,
          type: "INQUIRY_RECEIVED",
          aggregateType: "MESSAGE",
          aggregateId: inserted.id,
          payload: {
            messageId: inserted.id,
            conversationId,
            contactId: conversation.contactId,
            channel: inserted.channel,
            receivedAt: now.toISOString(),
          },
          occurredAt: now,
        }).onConflictDoNothing();
      }
      return inserted;
    }

    if (!input.provider || !input.externalMessageId) {
      throw new AppError("MESSAGE_CONFLICT", "The message could not be persisted.", 409);
    }

    const [existing] = await tx.select().from(messages).where(and(
      eq(messages.workspaceId, workspaceId),
      eq(messages.provider, input.provider),
      eq(messages.externalMessageId, input.externalMessageId),
    )).limit(1);
    if (!existing) throw new AppError("MESSAGE_CONFLICT", "The message could not be persisted.", 409);
    return existing;
  });
}

export async function setConversationHandlingMode(
  workspaceId: string,
  conversationId: string,
  mode: "AI" | "HUMAN",
  assignedUserId: string | null,
) {
  const now = new Date();
  const [conversation] = await db.update(conversations).set({
    handlingMode: mode,
    assignedUserId,
    aiPausedAt: mode === "HUMAN" ? now : null,
    updatedAt: now,
  }).where(and(
    eq(conversations.workspaceId, workspaceId),
    eq(conversations.id, conversationId),
  )).returning();
  if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
  return conversation;
}

export async function getConversationById(workspaceId: string, conversationId: string) {
  const [conversation] = await db.select().from(conversations).where(and(
    eq(conversations.workspaceId, workspaceId),
    eq(conversations.id, conversationId),
  )).limit(1);
  return conversation ?? null;
}

export async function closeConversation(workspaceId: string, conversationId: string) {
  const [conversation] = await db.update(conversations).set({ status: "CLOSED", updatedAt: new Date() })
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId))).returning();
  if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
  return conversation;
}

export async function listConversations(workspaceId: string, options: { limit?: number; offset?: number } = {}) {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const rows = await db.select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contacts, and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, conversations.contactId)))
    .where(eq(conversations.workspaceId, workspaceId))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
    .limit(limit)
    .offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(conversations).where(eq(conversations.workspaceId, workspaceId));
  return { items: rows, total: count, limit, offset };
}

export async function getConversationTimeline(workspaceId: string, conversationId: string) {
  const [row] = await db.select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contacts, and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, conversations.contactId)))
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
    .limit(1);
  if (!row) return null;

  const timeline = await db.select().from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.conversationId, conversationId),
  )).orderBy(asc(messages.createdAt));

  return { ...row, messages: timeline };
}

export async function listAppointments(workspaceId: string, options: AppointmentListOptions = {}) {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const conditions: SQL[] = [eq(appointments.workspaceId, workspaceId)];
  if (options.status) conditions.push(eq(appointments.status, options.status));
  if (options.from) conditions.push(gte(appointments.startsAt, options.from));
  if (options.to) conditions.push(lte(appointments.startsAt, options.to));

  const rows = await db.select({ appointment: appointments, contact: contacts })
    .from(appointments)
    .innerJoin(contacts, and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, appointments.contactId)))
    .where(and(...conditions))
    .orderBy(asc(appointments.startsAt))
    .limit(limit)
    .offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(appointments).where(and(...conditions));
  return { items: rows, total: count, limit, offset };
}

export async function getAppointment(workspaceId: string, appointmentId: string) {
  const [appointment] = await db.select().from(appointments).where(and(
    eq(appointments.workspaceId, workspaceId),
    eq(appointments.id, appointmentId),
  )).limit(1);
  return appointment ?? null;
}

export async function insertAppointment(
  workspaceId: string,
  input: AppointmentInput,
  external: { integrationId: string | null; externalEventId: string | null; status?: "PENDING" | "CONFIRMED"; bookingCommandId?: string },
) {
  await ensureContactInWorkspace(workspaceId, input.contactId);
  return db.transaction(async (tx) => {
    const [appointment] = await tx.insert(appointments).values({
      workspaceId,
      contactId: input.contactId,
      conversationId: input.conversationId ?? null,
      integrationId: external.integrationId,
      externalEventId: external.externalEventId,
      bookingCommandId: external.bookingCommandId ?? null,
      serviceId: input.serviceId ?? null,
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      status: external.status ?? "CONFIRMED",
      bookingSource: input.bookingSource ?? null,
      notes: input.notes ?? null,
    }).returning();
    if (appointment.status === "CONFIRMED") {
      await tx.insert(automationEvents).values({
        workspaceId,
        type: "APPOINTMENT_CONFIRMED",
        aggregateType: "APPOINTMENT",
        aggregateId: appointment.id,
        payload: {
          appointmentId: appointment.id,
          contactId: appointment.contactId,
          conversationId: appointment.conversationId,
          startsAt: appointment.startsAt.toISOString(),
        },
      }).onConflictDoNothing();
    }
    return appointment;
  });
}

/**
 * In-app booking is the authoritative fallback when no external calendar is
 * connected. Serialize competing bookings for a workspace before checking
 * overlaps and persist the appointment + domain event in the same transaction.
 */
function appointmentLocalDate(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (name: string) => parts.find((row) => row.type === name)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function assertNativePolicyAvailability(
  input: Pick<AppointmentInput, "startsAt" | "endsAt">,
  existing: Array<{ startsAt: Date; endsAt: Date }>,
  policy: NativeBookingPolicy,
) {
  const candidateDate = appointmentLocalDate(input.startsAt, policy.timezone);
  const bookingsOnDay = existing.filter((row) =>
    appointmentLocalDate(row.startsAt, policy.timezone) === candidateDate).length;
  if (bookingsOnDay >= policy.maxBookingsPerDay) {
    throw new AppError("APPOINTMENT_DAILY_LIMIT_REACHED",
      "The maximum number of bookings has been reached for that day.", 409);
  }
  const protectedStart = input.startsAt.getTime() - policy.bufferBeforeMinutes * 60_000;
  const protectedEnd = input.endsAt.getTime() + policy.bufferAfterMinutes * 60_000;
  if (existing.some((row) => {
    const existingProtectedStart = row.startsAt.getTime() - policy.bufferBeforeMinutes * 60_000;
    const existingProtectedEnd = row.endsAt.getTime() + policy.bufferAfterMinutes * 60_000;
    return existingProtectedStart < protectedEnd && existingProtectedEnd > protectedStart;
  })) {
    throw new AppError("APPOINTMENT_SLOT_UNAVAILABLE",
      "That time conflicts with another appointment or its required buffer.", 409);
  }
}

export async function insertNativeAppointment(
  workspaceId: string,
  input: AppointmentInput,
  policy: NativeBookingPolicy,
  bookingCommandId?: string,
) {
  await ensureContactInWorkspace(workspaceId, input.contactId);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
    const existing = await tx.select().from(appointments)
      .where(and(eq(appointments.workspaceId, workspaceId),
        inArray(appointments.status, ["PENDING", "CONFIRMED"]),
        lt(appointments.startsAt, new Date(input.endsAt.getTime() + 36 * 60 * 60_000)),
        gt(appointments.endsAt, new Date(input.startsAt.getTime() - 36 * 60 * 60_000))))
      .limit(1001);
    const reservations = await tx.select({
      startsAt: bookingReservations.startsAt, endsAt: bookingReservations.endsAt,
    }).from(bookingReservations).where(and(
      eq(bookingReservations.workspaceId, workspaceId),
      eq(bookingReservations.state, "ACTIVE"),
      ...(bookingCommandId ? [ne(bookingReservations.commandId, bookingCommandId)] : []),
      lt(bookingReservations.startsAt, new Date(input.endsAt.getTime() + 36 * 60 * 60_000)),
      gt(bookingReservations.endsAt, new Date(input.startsAt.getTime() - 36 * 60 * 60_000)),
    )).limit(1001);
    if (existing.length > 1000 || reservations.length > 1000) {
      throw new AppError("AVAILABILITY_INCOMPLETE", "The calendar is too busy to verify this appointment safely.", 503);
    }
    const sameRequest = existing.find((row) => bookingCommandId
      ? row.bookingCommandId === bookingCommandId
      : row.contactId === input.contactId
      && row.title === input.title
      && row.startsAt.getTime() === input.startsAt.getTime()
      && row.endsAt.getTime() === input.endsAt.getTime());
    if (sameRequest) return sameRequest;
    assertNativePolicyAvailability(input, [...existing, ...reservations], policy);
    const [appointment] = await tx.insert(appointments).values({
      workspaceId, contactId: input.contactId,
      conversationId: input.conversationId ?? null, integrationId: null,
      externalEventId: null, bookingCommandId: bookingCommandId ?? null, serviceId: input.serviceId ?? null,
      title: input.title, startsAt: input.startsAt, endsAt: input.endsAt,
      timezone: input.timezone, status: "CONFIRMED",
      bookingSource: input.bookingSource ?? null, notes: input.notes ?? null,
    }).returning();
    await tx.insert(automationEvents).values({
      workspaceId, type: "APPOINTMENT_CONFIRMED",
      aggregateType: "APPOINTMENT", aggregateId: appointment.id,
      payload: {
        appointmentId: appointment.id, contactId: appointment.contactId,
        conversationId: appointment.conversationId,
        startsAt: appointment.startsAt.toISOString(),
      },
    }).onConflictDoNothing();
    return appointment;
  });
}

export async function updateNativeAppointmentAfterReschedule(
  workspaceId: string,
  appointmentId: string,
  input: AppointmentRescheduleInput,
  policy: NativeBookingPolicy,
) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
    const [previous] = await tx.select().from(appointments).where(and(
      eq(appointments.workspaceId, workspaceId), eq(appointments.id, appointmentId),
    )).limit(1);
    if (!previous) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
    if (previous.status === "CANCELLED") {
      throw new AppError("APPOINTMENT_CANCELLED", "Cancelled appointments cannot be rescheduled.", 409);
    }
    const existing = await tx.select({
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
    }).from(appointments).where(and(
      eq(appointments.workspaceId, workspaceId), ne(appointments.id, appointmentId),
      inArray(appointments.status, ["PENDING", "CONFIRMED"]),
      lt(appointments.startsAt, new Date(input.endsAt.getTime() + 36 * 60 * 60_000)),
      gt(appointments.endsAt, new Date(input.startsAt.getTime() - 36 * 60 * 60_000)),
    )).limit(1001);
    const reservations = await tx.select({
      startsAt: bookingReservations.startsAt, endsAt: bookingReservations.endsAt,
    }).from(bookingReservations).where(and(
      eq(bookingReservations.workspaceId, workspaceId),
      eq(bookingReservations.state, "ACTIVE"),
      lt(bookingReservations.startsAt, new Date(input.endsAt.getTime() + 36 * 60 * 60_000)),
      gt(bookingReservations.endsAt, new Date(input.startsAt.getTime() - 36 * 60 * 60_000)),
    )).limit(1001);
    if (existing.length > 1000 || reservations.length > 1000) {
      throw new AppError("AVAILABILITY_INCOMPLETE", "The calendar is too busy to verify this appointment safely.", 503);
    }
    assertNativePolicyAvailability(input, [...existing, ...reservations], policy);
    const [appointment] = await tx.update(appointments).set({
      startsAt: input.startsAt, endsAt: input.endsAt, timezone: input.timezone,
      status: "CONFIRMED", updatedAt: new Date(),
    }).where(and(eq(appointments.workspaceId, workspaceId), eq(appointments.id, appointmentId))).returning();
    await tx.insert(automationEvents).values({
      workspaceId, type: "APPOINTMENT_RESCHEDULED",
      aggregateType: "APPOINTMENT", aggregateId: appointment.id,
      occurrenceKey: appointment.startsAt.toISOString(),
      payload: {
        appointmentId: appointment.id, contactId: appointment.contactId,
        conversationId: appointment.conversationId,
        startsAt: appointment.startsAt.toISOString(),
      },
    }).onConflictDoNothing();
    return appointment;
  });
}

export async function updateAppointmentAfterReschedule(
  workspaceId: string,
  appointmentId: string,
  input: AppointmentRescheduleInput,
  externalEventId?: string,
) {
  return db.transaction(async (tx) => {
    const [appointment] = await tx.update(appointments).set({
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      externalEventId: externalEventId,
      status: "CONFIRMED",
      updatedAt: new Date(),
    }).where(and(eq(appointments.workspaceId, workspaceId), eq(appointments.id, appointmentId))).returning();
    if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
    await tx.insert(automationEvents).values({
      workspaceId,
      type: "APPOINTMENT_RESCHEDULED",
      aggregateType: "APPOINTMENT",
      aggregateId: appointment.id,
      occurrenceKey: appointment.startsAt.toISOString(),
      payload: {
        appointmentId: appointment.id,
        contactId: appointment.contactId,
        conversationId: appointment.conversationId,
        startsAt: appointment.startsAt.toISOString(),
      },
    }).onConflictDoNothing();
    return appointment;
  });
}

export async function setAppointmentStatus(
  workspaceId: string,
  appointmentId: string,
  status: "PENDING" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW",
) {
  return db.transaction(async (tx) => {
    const [appointment] = await tx.update(appointments).set({ status, updatedAt: new Date() })
      .where(and(eq(appointments.workspaceId, workspaceId), eq(appointments.id, appointmentId))).returning();
    if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
    if (status === "CANCELLED") {
      await tx.insert(automationEvents).values({
        workspaceId,
        type: "APPOINTMENT_CANCELLED",
        aggregateType: "APPOINTMENT",
        aggregateId: appointment.id,
        payload: { appointmentId: appointment.id, startsAt: appointment.startsAt.toISOString() },
      }).onConflictDoNothing();
    }
    return appointment;
  });
}
