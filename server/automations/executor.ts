import { and, desc, eq, gt, isNull, notInArray, or } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "@/db";
import {
  appointments,
  businessProfiles,
  contacts,
  conversationHandlingEvents,
  conversations,
  leads,
  memberships,
  messages,
  notifications,
} from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { ProviderRequestError } from "@/server/providers/http";
import { sendSmsConversationText } from "@/server/sms/outbound";
import {
  sendWhatsAppConversationTemplate,
  sendWhatsAppConversationText,
} from "@/server/whatsapp/outbound";
import {
  claimAutomationDelivery,
  claimAutomationRun,
  completeAutomationRun,
  failAutomationRun,
  finishAutomationDelivery,
  getAutomationEvent,
  getAutomationSetting,
  listAutomationDeliveries,
  releaseAutomationRunForRetry,
} from "./repository";
import type {
  AppointmentConfirmationConfig,
  AppointmentReminderConfig,
  AutomationKey,
  MissedInquiryConfig,
} from "./schemas";

type DeliverySummary = { sent: number; skipped: number; failed: number };

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/{{([a-z_]+)}}/g, (_match, key: string) => values[key] ?? "");
}

async function automationContext(workspaceId: string, appointmentId: string) {
  const [row] = await db.select({
    appointment: appointments,
    contact: contacts,
    businessName: businessProfiles.businessName,
  }).from(appointments)
    .innerJoin(contacts, and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, appointments.contactId)))
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaceId))
    .where(and(eq(appointments.workspaceId, workspaceId), eq(appointments.id, appointmentId)))
    .limit(1);
  return row ?? null;
}

function appointmentVariables(context: NonNullable<Awaited<ReturnType<typeof automationContext>>>) {
  const appointment = context.appointment;
  return {
    name: context.contact.name ?? "there",
    business_name: context.businessName ?? "the business",
    service: appointment.title,
    appointment_date: new Intl.DateTimeFormat("en-US", {
      timeZone: appointment.timezone,
      dateStyle: "medium",
    }).format(appointment.startsAt),
    appointment_time: new Intl.DateTimeFormat("en-US", {
      timeZone: appointment.timezone,
      timeStyle: "short",
    }).format(appointment.startsAt),
  };
}

function isRetryableAutomationError(error: unknown) {
  if (error instanceof AppError) return error.status >= 500;
  if (error instanceof ZodError) return false;
  return true;
}

function deliveryFailureStatus(error: unknown): "FAILED" | "UNKNOWN" | "SKIPPED" {
  if (error instanceof AppError && (
    error.code === "SMS_IDENTITY_NOT_FOUND"
    || error.code === "WHATSAPP_IDENTITY_NOT_FOUND"
    || error.code === "WHATSAPP_TEMPLATE_REQUIRED"
  )) return "SKIPPED";
  if (error instanceof ProviderRequestError && error.status >= 400 && error.status < 500) return "FAILED";
  return "UNKNOWN";
}

async function existingDeliverySummary(
  workspaceId: string,
  delivery: { id: string; status: "PENDING" | "SENT" | "SKIPPED" | "FAILED" | "UNKNOWN" },
): Promise<DeliverySummary> {
  if (delivery.status === "SENT") return { sent: 1, skipped: 0, failed: 0 };
  if (delivery.status === "SKIPPED") return { sent: 0, skipped: 1, failed: 0 };
  if (delivery.status === "PENDING") {
    await finishAutomationDelivery(workspaceId, delivery.id, {
      status: "UNKNOWN",
      errorCode: "INTERRUPTED_DELIVERY",
      errorMessage: "A previous worker stopped after claiming this delivery. It was not retried to avoid sending a duplicate message.",
    });
  }
  return { sent: 0, skipped: 0, failed: 1 };
}

async function deliverInApp(input: {
  workspaceId: string;
  runId: string;
  userId: string | null;
  title: string;
  body: string;
  conversationId?: string | null;
  contactId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<DeliverySummary> {
  const recipient = input.userId ?? "workspace";
  const claimed = await claimAutomationDelivery({
    workspaceId: input.workspaceId,
    runId: input.runId,
    channel: "IN_APP",
    recipient,
  });
  if (!claimed.created) {
    return existingDeliverySummary(input.workspaceId, claimed.delivery);
  }

  const recipients = input.userId
    ? [input.userId]
    : (await db.select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.workspaceId, input.workspaceId)))
        .map((row) => row.userId);

  if (!recipients.length) {
    await finishAutomationDelivery(input.workspaceId, claimed.delivery.id, {
      status: "SKIPPED",
      errorCode: "NO_NOTIFICATION_RECIPIENTS",
      errorMessage: "No workspace members were available to receive the notification.",
    });
    return { sent: 0, skipped: 1, failed: 0 };
  }

  const noticeRows = await db.insert(notifications).values(recipients.map((userId) => ({
    workspaceId: input.workspaceId,
    userId,
    type: "AUTOMATION_NOTIFICATION",
    title: input.title,
    body: input.body,
    conversationId: input.conversationId ?? null,
    contactId: input.contactId ?? null,
    metadata: { automationRunId: input.runId, ...(input.metadata ?? {}) },
  }))).returning({ id: notifications.id });

  await finishAutomationDelivery(input.workspaceId, claimed.delivery.id, {
    status: "SENT",
    providerExternalId: noticeRows[0]?.id ?? null,
  });
  return { sent: 1, skipped: 0, failed: 0 };
}

async function deliverCustomerChannels(input: {
  workspaceId: string;
  runId: string;
  conversationId: string;
  channels: Array<"SMS" | "WHATSAPP">;
  text: string;
  whatsappTemplateName?: string | null;
  whatsappTemplateLanguage?: string;
}): Promise<DeliverySummary> {
  const summary: DeliverySummary = { sent: 0, skipped: 0, failed: 0 };

  for (const channel of input.channels) {
    const claimed = await claimAutomationDelivery({
      workspaceId: input.workspaceId,
      runId: input.runId,
      channel,
      recipient: input.conversationId,
    });
    if (!claimed.created) {
      const existing = await existingDeliverySummary(input.workspaceId, claimed.delivery);
      summary.sent += existing.sent;
      summary.skipped += existing.skipped;
      summary.failed += existing.failed;
      continue;
    }

    try {
      const message = channel === "SMS"
        ? await sendSmsConversationText(input.workspaceId, input.conversationId, {
            senderType: "SYSTEM",
            text: input.text,
            idempotencyKey: claimed.delivery.id,
            metadata: { automationRunId: input.runId },
          })
        : input.whatsappTemplateName
          ? await sendWhatsAppConversationTemplate(input.workspaceId, input.conversationId, {
              senderType: "SYSTEM",
              templateName: input.whatsappTemplateName,
              languageCode: input.whatsappTemplateLanguage ?? "en_US",
            })
          : await sendWhatsAppConversationText(input.workspaceId, input.conversationId, {
              senderType: "SYSTEM",
              text: input.text,
            });

      await finishAutomationDelivery(input.workspaceId, claimed.delivery.id, {
        status: "SENT",
        messageId: message.id,
        providerExternalId: message.externalMessageId,
      });
      summary.sent += 1;
    } catch (error) {
      const status = deliveryFailureStatus(error);
      await finishAutomationDelivery(input.workspaceId, claimed.delivery.id, {
        status,
        errorCode: error instanceof AppError ? error.code : "DELIVERY_FAILED",
        errorMessage: error instanceof Error ? error.message : "Automation delivery failed.",
      });
      if (status === "SKIPPED") summary.skipped += 1;
      else summary.failed += 1;
    }
  }

  return summary;
}

async function executeMissedInquiry(
  workspaceId: string,
  runId: string,
  event: NonNullable<Awaited<ReturnType<typeof getAutomationEvent>>>,
  config: MissedInquiryConfig,
) {
  const conversationId = typeof event.payload.conversationId === "string" ? event.payload.conversationId : null;
  if (!conversationId) return { sent: 0, skipped: 1, failed: 0 };

  const [conversation] = await db.select().from(conversations).where(and(
    eq(conversations.workspaceId, workspaceId),
    eq(conversations.id, conversationId),
  )).limit(1);
  if (!conversation || conversation.status !== "OPEN" || conversation.handlingMode !== "AI") {
    return { sent: 0, skipped: 1, failed: 0 };
  }

  const [newerCustomer] = await db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.conversationId, conversationId),
    eq(messages.direction, "INBOUND"),
    eq(messages.senderType, "CUSTOMER"),
    eq(messages.contentType, "TEXT"),
    gt(messages.createdAt, event.occurredAt),
  )).orderBy(desc(messages.createdAt)).limit(1);
  if (newerCustomer) return { sent: 0, skipped: 1, failed: 0 };

  const [outbound] = await db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.conversationId, conversationId),
    eq(messages.direction, "OUTBOUND"),
    gt(messages.createdAt, event.occurredAt),
    or(
      isNull(messages.status),
      notInArray(messages.status, ["FAILED", "SUPPRESSED"]),
    ),
  )).limit(1);
  if (outbound) return { sent: 0, skipped: 1, failed: 0 };

  const [contact] = await db.select().from(contacts).where(and(
    eq(contacts.workspaceId, workspaceId),
    eq(contacts.id, conversation.contactId),
  )).limit(1);
  const text = renderTemplate(config.message, { name: contact?.name ?? "there" });
  return deliverCustomerChannels({
    workspaceId,
    runId,
    conversationId,
    channels: config.channels,
    text,
  });
}

async function executeQualifiedLead(
  workspaceId: string,
  runId: string,
  event: NonNullable<Awaited<ReturnType<typeof getAutomationEvent>>>,
) {
  const setting = await getAutomationSetting(workspaceId, "QUALIFIED_LEAD_ASSIGNMENT");
  const leadId = typeof event.payload.leadId === "string" ? event.payload.leadId : null;
  const contactId = typeof event.payload.contactId === "string" ? event.payload.contactId : null;
  if (!leadId || !contactId) return { sent: 0, skipped: 1, failed: 0 };

  const assignedUserId = setting.config.assignedUserId;
  if (assignedUserId) {
    const [membership] = await db.select({ userId: memberships.userId }).from(memberships).where(and(
      eq(memberships.workspaceId, workspaceId),
      eq(memberships.userId, assignedUserId),
    )).limit(1);
    if (!membership) throw new AppError("AUTOMATION_ASSIGNEE_INVALID", "Configured lead assignee is no longer a workspace member.", 409);
  }

  if (assignedUserId) {
    await db.transaction(async (tx) => {
      await tx.update(leads).set({ assignedUserId, updatedAt: new Date() }).where(and(
        eq(leads.workspaceId, workspaceId),
        eq(leads.id, leadId),
      ));
      const [conversation] = await tx.select().from(conversations).where(and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.contactId, contactId),
        eq(conversations.status, "OPEN"),
      )).limit(1);
      if (conversation && conversation.assignedUserId !== assignedUserId) {
        await tx.update(conversations).set({ assignedUserId, updatedAt: new Date() }).where(eq(conversations.id, conversation.id));
        await tx.insert(conversationHandlingEvents).values({
          workspaceId,
          conversationId: conversation.id,
          type: "ASSIGNED",
          actorUserId: null,
          assignedUserId,
          metadata: { automationRunId: runId },
        });
      }
    });
  }

  if (!setting.config.notifyInApp) return { sent: 0, skipped: 1, failed: 0 };
  return deliverInApp({
    workspaceId,
    runId,
    userId: assignedUserId,
    title: "Qualified lead ready for follow-up",
    body: assignedUserId
      ? "A qualified lead was assigned to you."
      : "A lead qualified and is ready for team follow-up.",
    contactId,
    metadata: { leadId },
  });
}

async function executeAppointmentMessage(
  workspaceId: string,
  runId: string,
  event: NonNullable<Awaited<ReturnType<typeof getAutomationEvent>>>,
  key: "APPOINTMENT_CONFIRMATION" | "APPOINTMENT_REMINDER",
  config: AppointmentConfirmationConfig | AppointmentReminderConfig,
  expectedStartsAt?: string | null,
) {
  const appointmentId = typeof event.payload.appointmentId === "string" ? event.payload.appointmentId : null;
  if (!appointmentId) return { sent: 0, skipped: 1, failed: 0 };
  const context = await automationContext(workspaceId, appointmentId);
  if (!context || context.appointment.status !== "CONFIRMED" || !context.appointment.conversationId) {
    return { sent: 0, skipped: 1, failed: 0 };
  }
  if (key === "APPOINTMENT_REMINDER" && expectedStartsAt && context.appointment.startsAt.toISOString() !== expectedStartsAt) {
    return { sent: 0, skipped: 1, failed: 0 };
  }
  if (key === "APPOINTMENT_REMINDER" && context.appointment.startsAt.getTime() <= Date.now()) {
    return { sent: 0, skipped: 1, failed: 0 };
  }

  return deliverCustomerChannels({
    workspaceId,
    runId,
    conversationId: context.appointment.conversationId,
    channels: config.channels,
    text: renderTemplate(config.message, appointmentVariables(context)),
    whatsappTemplateName: config.whatsappTemplateName,
    whatsappTemplateLanguage: config.whatsappTemplateLanguage,
  });
}

async function executeEscalation(
  workspaceId: string,
  runId: string,
  event: NonNullable<Awaited<ReturnType<typeof getAutomationEvent>>>,
) {
  const setting = await getAutomationSetting(workspaceId, "HUMAN_ESCALATION");
  const conversationId = typeof event.payload.conversationId === "string" ? event.payload.conversationId : null;
  const contactId = typeof event.payload.contactId === "string" ? event.payload.contactId : null;
  if (!conversationId) return { sent: 0, skipped: 1, failed: 0 };

  const assignedUserId = setting.config.assignedUserId;
  if (assignedUserId) {
    const [membership] = await db.select({ userId: memberships.userId }).from(memberships).where(and(
      eq(memberships.workspaceId, workspaceId),
      eq(memberships.userId, assignedUserId),
    )).limit(1);
    if (!membership) throw new AppError("AUTOMATION_ASSIGNEE_INVALID", "Configured escalation assignee is no longer a workspace member.", 409);

    await db.transaction(async (tx) => {
      const [conversation] = await tx.select().from(conversations).where(and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.id, conversationId),
      )).limit(1);
      if (conversation && conversation.assignedUserId !== assignedUserId) {
        await tx.update(conversations).set({ assignedUserId, updatedAt: new Date() }).where(eq(conversations.id, conversationId));
        await tx.insert(conversationHandlingEvents).values({
          workspaceId,
          conversationId,
          type: "ASSIGNED",
          actorUserId: null,
          assignedUserId,
          metadata: { automationRunId: runId },
        });
      }
    });
  }

  if (!setting.config.notifyInApp) return { sent: 0, skipped: 1, failed: 0 };
  const reason = typeof event.payload.reason === "string" ? event.payload.reason : null;
  return deliverInApp({
    workspaceId,
    runId,
    userId: assignedUserId,
    title: "Customer needs human help",
    body: reason ? `AI escalated this conversation: ${reason}` : "AI escalated a customer conversation for human follow-up.",
    conversationId,
    contactId,
  });
}

export async function executeAutomationRun(workspaceId: string, runId: string) {
  const run = await claimAutomationRun(workspaceId, runId);
  if (!run) return { claimed: false as const };

  try {
    const event = await getAutomationEvent(workspaceId, run.eventId);
    if (!event) throw new AppError("AUTOMATION_EVENT_NOT_FOUND", "Automation event not found.", 404);

    const setting = await getAutomationSetting(workspaceId, run.key as AutomationKey);
    if (!setting.enabled) {
      await completeAutomationRun(workspaceId, runId, "SKIPPED", { reason: "AUTOMATION_DISABLED" });
      return { claimed: true as const, status: "SKIPPED" as const };
    }

    let summary: DeliverySummary = { sent: 0, skipped: 0, failed: 0 };
    if (run.key === "MISSED_INQUIRY_RECOVERY") {
      summary = await executeMissedInquiry(workspaceId, runId, event, setting.config as MissedInquiryConfig);
    } else if (run.key === "QUALIFIED_LEAD_ASSIGNMENT") {
      summary = await executeQualifiedLead(workspaceId, runId, event);
    } else if (run.key === "APPOINTMENT_CONFIRMATION") {
      summary = await executeAppointmentMessage(
        workspaceId,
        runId,
        event,
        run.key,
        setting.config as AppointmentConfirmationConfig,
      );
    } else if (run.key === "APPOINTMENT_REMINDER") {
      const expectedStartsAt = typeof run.metadata.expectedStartsAt === "string" ? run.metadata.expectedStartsAt : null;
      summary = await executeAppointmentMessage(
        workspaceId,
        runId,
        event,
        run.key,
        setting.config as AppointmentReminderConfig,
        expectedStartsAt,
      );
    } else if (run.key === "HUMAN_ESCALATION") {
      summary = await executeEscalation(workspaceId, runId, event);
    }

    const finalStatus = summary.failed > 0 ? "FAILED" : summary.sent > 0 ? "COMPLETED" : "SKIPPED";
    if (finalStatus === "FAILED") {
      const message = summary.sent > 0
        ? "One or more requested automation deliveries failed."
        : "All requested automation deliveries failed.";
      await failAutomationRun(
        workspaceId,
        runId,
        new AppError("AUTOMATION_DELIVERY_FAILED", message, 502),
        { deliverySummary: summary },
      );
    } else {
      await completeAutomationRun(workspaceId, runId, finalStatus, { deliverySummary: summary });
    }
    return { claimed: true as const, status: finalStatus, summary };
  } catch (error) {
    const deliveries = await listAutomationDeliveries(workspaceId, runId).catch(() => []);
    if (deliveries.length === 0 && isRetryableAutomationError(error)) {
      await releaseAutomationRunForRetry(workspaceId, runId).catch(() => undefined);
      throw error;
    }

    await failAutomationRun(workspaceId, runId, error).catch(() => undefined);
    return {
      claimed: true as const,
      status: "FAILED" as const,
      error: error instanceof Error ? error.message : "Automation execution failed.",
    };
  }
}
