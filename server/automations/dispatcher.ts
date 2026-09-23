import { z } from "zod";
import { enqueueUniqueJob, enqueueUniqueJobAt } from "@/server/jobs";
import { AUTOMATION_EXECUTE_RUN } from "@/server/jobs/queues";
import {
  createAutomationRun,
  getAutomationEvent,
  getAutomationSetting,
  markAutomationEventDispatched,
} from "./repository";
import type { AutomationKey } from "./schemas";

const appointmentPayloadSchema = z.object({
  appointmentId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }),
  // Legacy events were recorded before appointment revisions existed.
  revision: z.number().int().nonnegative().default(0),
});

async function enqueueRun(run: {
  id: string;
  workspaceId: string;
  scheduledFor: Date | null;
}) {
  const payload = { workspaceId: run.workspaceId, runId: run.id };
  if (run.scheduledFor && run.scheduledFor.getTime() > Date.now()) {
    return enqueueUniqueJobAt(AUTOMATION_EXECUTE_RUN, run.id, payload, run.scheduledFor);
  }
  return enqueueUniqueJob(AUTOMATION_EXECUTE_RUN, run.id, payload);
}

async function createAndEnqueue(input: {
  workspaceId: string;
  eventId: string;
  key: AutomationKey;
  occurrenceKey?: string;
  scheduledFor?: Date | null;
  metadata?: Record<string, unknown>;
}) {
  const run = await createAutomationRun(input);
  await enqueueRun(run);
  return run;
}

export async function dispatchAutomationEvent(workspaceId: string, eventId: string) {
  const event = await getAutomationEvent(workspaceId, eventId);
  if (!event) return { missing: true as const, runs: 0 };

  let runs = 0;

  if (event.type === "INQUIRY_RECEIVED") {
    const setting = await getAutomationSetting(workspaceId, "MISSED_INQUIRY_RECOVERY");
    if (setting.enabled) {
      const scheduledFor = new Date(event.occurredAt.getTime() + setting.config.delayMinutes * 60_000);
      await createAndEnqueue({
        workspaceId,
        eventId,
        key: "MISSED_INQUIRY_RECOVERY",
        occurrenceKey: "follow-up",
        scheduledFor,
      });
      runs += 1;
    }
  }

  if (event.type === "LEAD_QUALIFIED") {
    const setting = await getAutomationSetting(workspaceId, "QUALIFIED_LEAD_ASSIGNMENT");
    if (setting.enabled) {
      await createAndEnqueue({ workspaceId, eventId, key: "QUALIFIED_LEAD_ASSIGNMENT" });
      runs += 1;
    }
  }

  if (event.type === "APPOINTMENT_CONFIRMED") {
    const confirmation = await getAutomationSetting(workspaceId, "APPOINTMENT_CONFIRMATION");
    if (confirmation.enabled) {
      await createAndEnqueue({ workspaceId, eventId, key: "APPOINTMENT_CONFIRMATION" });
      runs += 1;
    }
    runs += await scheduleAppointmentReminders(workspaceId, eventId, event.payload);
  }

  if (event.type === "APPOINTMENT_RESCHEDULED") {
    runs += await scheduleAppointmentReminders(workspaceId, eventId, event.payload);
  }

  if (event.type === "CONVERSATION_ESCALATED") {
    const setting = await getAutomationSetting(workspaceId, "HUMAN_ESCALATION");
    if (setting.enabled) {
      await createAndEnqueue({ workspaceId, eventId, key: "HUMAN_ESCALATION" });
      runs += 1;
    }
  }

  await markAutomationEventDispatched(workspaceId, eventId);
  return { missing: false as const, runs };
}

async function scheduleAppointmentReminders(
  workspaceId: string,
  eventId: string,
  payload: Record<string, unknown>,
) {
  const setting = await getAutomationSetting(workspaceId, "APPOINTMENT_REMINDER");
  if (!setting.enabled) return 0;

  const appointment = appointmentPayloadSchema.parse(payload);
  const startsAt = new Date(appointment.startsAt);
  const offsets = [
    { key: `before:${setting.config.firstMinutesBefore}`, minutes: setting.config.firstMinutesBefore },
    ...(setting.config.secondMinutesBefore === null
      ? []
      : [{ key: `before:${setting.config.secondMinutesBefore}`, minutes: setting.config.secondMinutesBefore }]),
  ];

  let count = 0;
  for (const offset of offsets) {
    const scheduledFor = new Date(startsAt.getTime() - offset.minutes * 60_000);
    await createAndEnqueue({
      workspaceId,
      eventId,
      key: "APPOINTMENT_REMINDER",
      occurrenceKey: offset.key,
      scheduledFor,
      metadata: { appointmentId: appointment.appointmentId, expectedStartsAt: appointment.startsAt, expectedAppointmentRevision: appointment.revision, minutesBefore: offset.minutes },
    });
    count += 1;
  }
  return count;
}
