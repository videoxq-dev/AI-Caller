import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import {
  appointments, bookingCommands, bookingDrafts, bookingReservations,
  contacts, conversations,
} from "@/db/schema";
import { requireActiveWorkspaceAgent } from "@/server/agent/service";
import { insertAppointment, insertNativeAppointment } from "@/server/domain/core/repository";
import { filterSlotsThroughLocalPolicy, validateNativeBooking } from "@/server/domain/core/native-calendar";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { resolveCalendarProviderForIntegration } from "@/server/providers/registry";
import { ProviderRequestError } from "@/server/providers/http";
import { currentBookingBinding, requireBookingService } from "./offers";

type Command = typeof bookingCommands.$inferSelect;
type Snapshot = {
  serviceId: string;
  title: string;
  durationMinutes: number;
  startsAt: string;
  endsAt: string;
  timezone: string;
  location: string | null;
  contactId: string;
  conversationId: string | null;
  attendeeName: string | null;
  attendeeEmail: string | null;
  bindingFingerprint: string;
};

function snapshotOf(command: Command): Snapshot {
  const data = command.snapshot as Partial<Snapshot>;
  if (!data.serviceId || !data.title || !data.startsAt || !data.endsAt ||
    !data.timezone || !data.contactId || !data.bindingFingerprint ||
    !Number.isSafeInteger(data.durationMinutes)) {
    throw new AppError("BOOKING_SNAPSHOT_INVALID", "Booking command requires staff review.", 409);
  }
  return data as Snapshot;
}

async function savedAppointment(command: Command) {
  const [row] = await db.select().from(appointments).where(and(
    eq(appointments.workspaceId, command.workspaceId),
    eq(appointments.bookingCommandId, command.id),
  )).limit(1);
  return row ?? null;
}

async function finish(command: Command, appointment: typeof appointments.$inferSelect, now = new Date()) {
  return db.transaction(async (tx) => {
    await tx.update(bookingCommands).set({
      state: "CONFIRMED", appointmentId: appointment.id,
      providerExternalId: appointment.externalEventId,
      leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
      lastErrorCode: null, confirmedAt: now, updatedAt: now,
    }).where(and(eq(bookingCommands.id, command.id), eq(bookingCommands.workspaceId, command.workspaceId)));
    await tx.update(bookingDrafts).set({
      status: "CONFIRMED", updatedAt: now,
    }).where(and(eq(bookingDrafts.id, command.draftId),
      eq(bookingDrafts.workspaceId, command.workspaceId),
      eq(bookingDrafts.bookingCommandId, command.id)));
    await tx.update(bookingReservations).set({
      state: "RELEASED", releasedAt: now,
    }).where(and(eq(bookingReservations.workspaceId, command.workspaceId),
      eq(bookingReservations.commandId, command.id), eq(bookingReservations.state, "ACTIVE")));
    return { state: "CONFIRMED" as const, appointmentId: appointment.id,
      startsAt: appointment.startsAt.toISOString(), endsAt: appointment.endsAt.toISOString(),
      timezone: appointment.timezone };
  });
}

async function failWithoutSideEffect(command: Command, code: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(bookingCommands).set({
      state: "FAILED", lastErrorCode: code.slice(0, 100),
      leaseOwner: null, leaseExpiresAt: null, updatedAt: now,
    }).where(and(eq(bookingCommands.id, command.id),
      eq(bookingCommands.workspaceId, command.workspaceId),
      inArray(bookingCommands.state, ["PENDING", "COMMITTING", "RECONCILING"])));
    await tx.update(bookingDrafts).set({
      status: "FAILED", updatedAt: now,
    }).where(and(eq(bookingDrafts.id, command.draftId),
      eq(bookingDrafts.workspaceId, command.workspaceId),
      eq(bookingDrafts.bookingCommandId, command.id)));
    await tx.update(bookingReservations).set({
      state: "RELEASED", releasedAt: now,
    }).where(and(eq(bookingReservations.workspaceId, command.workspaceId),
      eq(bookingReservations.commandId, command.id), eq(bookingReservations.state, "ACTIVE")));
  });
  return { state: "FAILED" as const, code };
}

async function uncertain(command: Command, code: string) {
  const now = new Date();
  await db.update(bookingCommands).set({
    state: "RECONCILING", lastErrorCode: code.slice(0, 100),
    leaseOwner: null, leaseExpiresAt: null,
    nextAttemptAt: new Date(now.getTime() + 60_000), updatedAt: now,
  }).where(and(eq(bookingCommands.id, command.id),
    eq(bookingCommands.workspaceId, command.workspaceId),
    inArray(bookingCommands.state, ["COMMITTING", "RECONCILING"])));
  await db.update(bookingDrafts).set({
    status: "RECONCILING", updatedAt: now,
  }).where(and(eq(bookingDrafts.id, command.draftId),
    eq(bookingDrafts.workspaceId, command.workspaceId),
    eq(bookingDrafts.bookingCommandId, command.id)));
  return { state: "RECONCILING" as const, code };
}

async function checkExecutionPolicy(command: Command, data: Snapshot) {
  await requireActiveWorkspaceAgent(command.workspaceId, "BOOK_APPOINTMENT");
  if (data.conversationId) {
    const [conversation] = await db.select().from(conversations).where(and(
      eq(conversations.id, data.conversationId),
      eq(conversations.workspaceId, command.workspaceId),
      eq(conversations.contactId, data.contactId),
    )).limit(1);
    if (!conversation || conversation.handlingMode === "HUMAN") {
      throw new AppError("BOOKING_HUMAN_HANDLING", "Staff controls this conversation.", 409);
    }
  }
  const service = await requireBookingService(command.workspaceId, data.serviceId);
  if (service.durationMinutes !== data.durationMinutes) {
    throw new AppError("BOOKING_SERVICE_CHANGED", "The service duration changed before booking.", 409);
  }
  const binding = await currentBookingBinding(command.workspaceId, service);
  if (binding.fingerprint !== data.bindingFingerprint ||
    binding.provider !== command.provider ||
    binding.integrationId !== command.integrationId) {
    throw new AppError("BOOKING_BINDING_CHANGED", "Calendar settings changed before booking.", 409);
  }
}

async function persistExternal(command: Command, data: Snapshot) {
  if (!command.providerExternalId || !command.integrationId) {
    return uncertain(command, "BOOKING_PROVIDER_REFERENCE_MISSING");
  }
  if (command.lastErrorCode === "BOOKING_PROVIDER_TIME_MISMATCH") {
    return { state: "RECONCILING" as const, code: "BOOKING_PROVIDER_TIME_MISMATCH" };
  }
  try {
    const existing = await savedAppointment(command);
    if (existing) return await finish(command, existing);
    const appointment = await insertAppointment(command.workspaceId, {
      contactId: data.contactId, conversationId: data.conversationId,
      serviceId: data.serviceId, title: data.title,
      startsAt: new Date(data.startsAt), endsAt: new Date(data.endsAt),
      timezone: data.timezone, bookingSource: "AI_BOOKING_V2",
      notes: data.location, attendeeName: data.attendeeName,
      attendeeEmail: data.attendeeEmail,
    }, {
      integrationId: command.integrationId, externalEventId: command.providerExternalId,
      status: "CONFIRMED", bookingCommandId: command.id,
    });
    return await finish(command, appointment);
  } catch (error) {
    logger.error({ err: error, workspaceId: command.workspaceId, commandId: command.id },
      "External booking succeeded; appointment receipt requires reconciliation");
    return uncertain(command, "BOOKING_LOCAL_PERSISTENCE_UNCERTAIN");
  }
}

export async function executeBookingCommand(workspaceId: string, commandId: string) {
  const leaseOwner = randomUUID(), now = new Date();
  const [claimed] = await db.update(bookingCommands).set({
    state: "COMMITTING", leaseOwner, leaseExpiresAt: new Date(now.getTime() + 45_000),
    attemptCount: /* committed claims count, not provider attempts */ 1,
    updatedAt: now,
  }).where(and(eq(bookingCommands.workspaceId, workspaceId),
    eq(bookingCommands.id, commandId), eq(bookingCommands.state, "PENDING"))).returning();
  if (!claimed) {
    const [existing] = await db.select().from(bookingCommands).where(and(
      eq(bookingCommands.workspaceId, workspaceId),
      eq(bookingCommands.id, commandId),
    )).limit(1);
    if (!existing) throw new AppError("BOOKING_COMMAND_NOT_FOUND", "Booking command not found.", 404);
    const result = await savedAppointment(existing);
    if (result) return finish(existing, result);
    return { state: existing.state, commandId: existing.id };
  }
  const command = claimed;
  const data = snapshotOf(command);
  try {
    await checkExecutionPolicy(command, data);
    if (command.provider === "native") {
      const policy = await validateNativeBooking(workspaceId, {
        startsAt: new Date(data.startsAt), endsAt: new Date(data.endsAt),
      });
      try {
        const appointment = await insertNativeAppointment(workspaceId, {
          contactId: data.contactId, conversationId: data.conversationId,
          serviceId: data.serviceId, title: data.title,
          startsAt: new Date(data.startsAt), endsAt: new Date(data.endsAt),
          timezone: data.timezone, bookingSource: "AI_BOOKING_V2",
          notes: data.location, attendeeName: data.attendeeName,
          attendeeEmail: data.attendeeEmail,
        }, policy, command.id);
        return await finish(command, appointment);
      } catch (error) {
        const persisted = await savedAppointment(command);
        if (persisted) return finish(command, persisted);
        if (error instanceof AppError && error.status < 500) {
          return failWithoutSideEffect(command, error.code);
        }
        return uncertain(command, "BOOKING_NATIVE_PERSISTENCE_UNCERTAIN");
      }
    }
    if (!command.integrationId) return failWithoutSideEffect(command, "BOOKING_BINDING_MISSING");
    const provider = await resolveCalendarProviderForIntegration(workspaceId, command.integrationId);
    const requested = { startsAt: new Date(data.startsAt), endsAt: new Date(data.endsAt),
      timezone: data.timezone, durationMinutes: data.durationMinutes };
    const available = await provider.getAvailability(requested);
    const checked = await filterSlotsThroughLocalPolicy(workspaceId, requested, available, new Date(), command.id);
    if (!checked.slots.some((slot) => slot.startsAt.getTime() === requested.startsAt.getTime() &&
      slot.endsAt.getTime() === requested.endsAt.getTime())) {
      return failWithoutSideEffect(command, "APPOINTMENT_SLOT_UNAVAILABLE");
    }
    // Persist that the provider call might happen BEFORE touching the network.
    await db.update(bookingCommands).set({
      providerAttemptedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(bookingCommands.id, command.id),
      eq(bookingCommands.workspaceId, workspaceId),
      eq(bookingCommands.state, "COMMITTING"),
      eq(bookingCommands.leaseOwner, leaseOwner)));
    const created = await provider.book({
      startsAt: requested.startsAt, endsAt: requested.endsAt,
      timezone: requested.timezone, title: data.title,
      attendeeName: data.attendeeName ?? undefined,
      attendeeEmail: data.attendeeEmail ?? undefined,
      location: data.location ?? undefined,
      idempotencyKey: command.providerEventKey ?? undefined,
    });
    if (!created.externalId || !Number.isFinite(created.startsAt.getTime()) ||
      !Number.isFinite(created.endsAt.getTime()) ||
      created.startsAt.getTime() !== requested.startsAt.getTime() ||
      created.endsAt.getTime() !== requested.endsAt.getTime()) {
      await db.update(bookingCommands).set({
        providerExternalId: created.externalId || null,
        lastErrorCode: "BOOKING_PROVIDER_TIME_MISMATCH", updatedAt: new Date(),
      }).where(and(eq(bookingCommands.id, command.id), eq(bookingCommands.workspaceId, workspaceId)));
      return uncertain(command, "BOOKING_PROVIDER_TIME_MISMATCH");
    }
    await db.update(bookingCommands).set({
      providerExternalId: created.externalId, updatedAt: new Date(),
    }).where(and(eq(bookingCommands.id, command.id), eq(bookingCommands.workspaceId, workspaceId)));
    return persistExternal({ ...command, providerExternalId: created.externalId }, data);
  } catch (error) {
    const persisted = await savedAppointment(command);
    if (persisted) return finish(command, persisted);
    const [latest] = await db.select().from(bookingCommands).where(and(
      eq(bookingCommands.id, command.id), eq(bookingCommands.workspaceId, workspaceId),
    )).limit(1);
    if (!latest?.providerAttemptedAt) {
      return failWithoutSideEffect(command, error instanceof AppError ? error.code : "BOOKING_PRECOMMIT_FAILED");
    }
    // A timeout, dropped response or database error after possible provider
    // creation cannot establish a failed appointment. Keep the reservation.
    const code = error instanceof AppError ? error.code
      : error instanceof ProviderRequestError ? "BOOKING_PROVIDER_" + error.status
        : "BOOKING_PROVIDER_OUTCOME_UNCERTAIN";
    return uncertain(command, code);
  }
}

export async function recoverBookingCommands(limit = 50) {
  const now = new Date();
  const work = await db.select().from(bookingCommands).where(or(
    eq(bookingCommands.state, "PENDING"),
    and(eq(bookingCommands.state, "COMMITTING"), lt(bookingCommands.leaseExpiresAt, now)),
    and(eq(bookingCommands.state, "RECONCILING"),
      or(isNull(bookingCommands.nextAttemptAt), lt(bookingCommands.nextAttemptAt, now))),
  )).orderBy(asc(bookingCommands.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
  let confirmed = 0, unresolved = 0;
  for (const command of work) {
    try {
      if (command.state === "PENDING") {
        const result = await executeBookingCommand(command.workspaceId, command.id);
        if (result.state === "CONFIRMED") confirmed++;
        else if (result.state === "RECONCILING") unresolved++;
        continue;
      }
      const existing = await savedAppointment(command);
      if (existing) {
        await finish(command, existing);
        confirmed++;
        continue;
      }
      if (command.state === "COMMITTING") {
        await uncertain(command, "BOOKING_WORKER_LEASE_EXPIRED");
      }
      if (command.providerExternalId && command.lastErrorCode !== "BOOKING_PROVIDER_TIME_MISMATCH") {
        const result = await persistExternal(command, snapshotOf(command));
        if (result.state === "CONFIRMED") confirmed++;
        else unresolved++;
        continue;
      }
      if (command.provider === "google" && command.integrationId && command.providerEventKey) {
        const provider = await resolveCalendarProviderForIntegration(command.workspaceId, command.integrationId);
        const found = await provider.lookupByKey?.({ idempotencyKey: command.providerEventKey });
        if (found && found.startsAt.toISOString() === snapshotOf(command).startsAt &&
          found.endsAt.toISOString() === snapshotOf(command).endsAt) {
          await db.update(bookingCommands).set({
            providerExternalId: found.externalId, lastErrorCode: null, updatedAt: new Date(),
          }).where(and(eq(bookingCommands.id, command.id),
            eq(bookingCommands.workspaceId, command.workspaceId)));
          const result = await persistExternal({ ...command, providerExternalId: found.externalId, lastErrorCode: null },
            snapshotOf(command));
          if (result.state === "CONFIRMED") confirmed++;
          else unresolved++;
          continue;
        }
      }
      // Outlook has transactionId but no verified read-by-key adapter here.
      // Cal.com and Calendly lack the same proven key contract. Do not blindly
      // reissue ambiguous external creates or free protected capacity.
      unresolved++;
    } catch (error) {
      logger.error({ err: error, workspaceId: command.workspaceId, commandId: command.id },
        "Booking reconciliation needs a later retry or staff review");
      unresolved++;
    }
  }
  return { checked: work.length, confirmed, unresolved };
}
