import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  appointments,
  automationDeliveries,
  businessProfiles,
  contacts,
  conversationHandlingEvents,
  conversations,
  leads,
  memberships,
  notifications,
  workflowActionRuns,
} from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { ProviderRequestError } from "@/server/providers/http";
import { sendSmsConversationText } from "@/server/sms/outbound";
import type { WorkflowAction } from "./action-registry";
import {
  claimAutomationDelivery,
  finishPendingAutomationDelivery,
  finishWorkflowActionRun,
  getAutomationDelivery,
} from "./repository";

type AutomationEvent = {
  type: string;
  payload: Record<string, unknown>;
};

export type WorkflowActionTerminalStatus = "COMPLETED" | "SKIPPED" | "FAILED" | "UNKNOWN";

type CustomerContext = {
  contactId: string | null;
  conversationId: string | null;
  leadId: string | null;
  variables: Record<string, string>;
};

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/{{([a-z_]+)}}/g, (_match, key: string) => values[key] ?? "");
}

async function resolveBusinessName(workspaceId: string) {
  const [profile] = await db.select({ businessName: businessProfiles.businessName })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId))
    .limit(1);
  return profile?.businessName ?? "the business";
}

async function openConversationForContact(workspaceId: string, contactId: string) {
  const [conversation] = await db.select({ id: conversations.id }).from(conversations).where(and(
    eq(conversations.workspaceId, workspaceId),
    eq(conversations.contactId, contactId),
    eq(conversations.status, "OPEN"),
  )).limit(1);
  return conversation?.id ?? null;
}

export async function resolveWorkflowCustomerContext(
  workspaceId: string,
  event: AutomationEvent,
): Promise<CustomerContext> {
  const businessName = await resolveBusinessName(workspaceId);

  if (event.type === "LEAD_QUALIFIED") {
    const leadId = typeof event.payload.leadId === "string" ? event.payload.leadId : null;
    const contactId = typeof event.payload.contactId === "string" ? event.payload.contactId : null;
    if (!leadId || !contactId) {
      return { contactId, conversationId: null, leadId, variables: { name: "there", business_name: businessName } };
    }
    const [contact] = await db.select({ name: contacts.name }).from(contacts).where(and(
      eq(contacts.workspaceId, workspaceId),
      eq(contacts.id, contactId),
    )).limit(1);
    return {
      contactId,
      conversationId: await openConversationForContact(workspaceId, contactId),
      leadId,
      variables: { name: contact?.name ?? "there", business_name: businessName },
    };
  }

  if (event.type === "APPOINTMENT_CONFIRMED"
    || event.type === "APPOINTMENT_RESCHEDULED"
    || event.type === "APPOINTMENT_CANCELLED") {
    const appointmentId = typeof event.payload.appointmentId === "string" ? event.payload.appointmentId : null;
    if (!appointmentId) {
      return { contactId: null, conversationId: null, leadId: null, variables: { name: "there", business_name: businessName } };
    }
    const [row] = await db.select({
      appointment: appointments,
      contactName: contacts.name,
    }).from(appointments)
      .innerJoin(contacts, and(
        eq(contacts.workspaceId, workspaceId),
        eq(contacts.id, appointments.contactId),
      ))
      .where(and(
        eq(appointments.workspaceId, workspaceId),
        eq(appointments.id, appointmentId),
      )).limit(1);
    if (!row) {
      return { contactId: null, conversationId: null, leadId: null, variables: { name: "there", business_name: businessName } };
    }
    const appointment = row.appointment;
    return {
      contactId: appointment.contactId,
      conversationId: appointment.conversationId
        ?? await openConversationForContact(workspaceId, appointment.contactId),
      leadId: null,
      variables: {
        name: row.contactName ?? "there",
        business_name: businessName,
        service: appointment.title,
        appointment_date: new Intl.DateTimeFormat("en-US", {
          timeZone: appointment.timezone,
          dateStyle: "medium",
        }).format(appointment.startsAt),
        appointment_time: new Intl.DateTimeFormat("en-US", {
          timeZone: appointment.timezone,
          timeStyle: "short",
        }).format(appointment.startsAt),
      },
    };
  }

  const conversationId = typeof event.payload.conversationId === "string"
    ? event.payload.conversationId
    : null;
  const payloadContactId = typeof event.payload.contactId === "string"
    ? event.payload.contactId
    : null;
  if (!conversationId) {
    return {
      contactId: payloadContactId,
      conversationId: null,
      leadId: null,
      variables: { name: "there", business_name: businessName },
    };
  }
  const [row] = await db.select({
    contactId: conversations.contactId,
    contactName: contacts.name,
  }).from(conversations)
    .innerJoin(contacts, and(
      eq(contacts.workspaceId, workspaceId),
      eq(contacts.id, conversations.contactId),
    ))
    .where(and(
      eq(conversations.workspaceId, workspaceId),
      eq(conversations.id, conversationId),
    )).limit(1);
  return {
    contactId: row?.contactId ?? payloadContactId,
    conversationId: row ? conversationId : null,
    leadId: null,
    variables: { name: row?.contactName ?? "there", business_name: businessName },
  };
}

async function assertCurrentWorkspaceMember(workspaceId: string, userId: string) {
  const [member] = await db.select({ userId: memberships.userId }).from(memberships).where(and(
    eq(memberships.workspaceId, workspaceId),
    eq(memberships.userId, userId),
  )).limit(1);
  if (!member) {
    throw new AppError(
      "WORKFLOW_STAFF_INVALID",
      "Configured workflow staff member is no longer part of this workspace.",
      409,
    );
  }
}

async function executeAssignLead(input: {
  workspaceId: string;
  runId: string;
  actionRunId: string;
  action: Extract<WorkflowAction, { type: "ASSIGN_LEAD" }>;
  context: CustomerContext;
}) {
  const leadId = input.context.leadId;
  if (!leadId) {
    await finishWorkflowActionRun(input.workspaceId, input.actionRunId, {
      status: "SKIPPED",
      errorCode: "LEAD_CONTEXT_UNAVAILABLE",
      errorMessage: "Lead context is no longer available for this workflow event.",
    });
    return "SKIPPED" as const;
  }

  return db.transaction(async tx => {
    const [member] = await tx.select({ userId: memberships.userId }).from(memberships).where(and(
      eq(memberships.workspaceId, input.workspaceId),
      eq(memberships.userId, input.action.userId),
    )).limit(1);
    if (!member) {
      throw new AppError(
        "WORKFLOW_STAFF_INVALID",
        "Configured lead assignee is no longer part of this workspace.",
        409,
      );
    }

    const [lead] = await tx.select().from(leads).where(and(
      eq(leads.workspaceId, input.workspaceId),
      eq(leads.id, leadId),
    )).for("update").limit(1);
    if (!lead || lead.status !== "QUALIFIED") {
      await tx.update(workflowActionRuns).set({
        status: "SKIPPED",
        completedAt: new Date(),
        errorCode: "LEAD_NOT_QUALIFIED",
        errorMessage: "Lead is no longer qualified.",
        result: {},
        updatedAt: new Date(),
      }).where(and(
        eq(workflowActionRuns.workspaceId, input.workspaceId),
        eq(workflowActionRuns.id, input.actionRunId),
        eq(workflowActionRuns.status, "RUNNING"),
      ));
      return "SKIPPED" as const;
    }

    if (lead.assignedUserId !== input.action.userId) {
      await tx.update(leads).set({
        assignedUserId: input.action.userId,
        updatedAt: new Date(),
      }).where(and(
        eq(leads.workspaceId, input.workspaceId),
        eq(leads.id, lead.id),
      ));
    }

    let conversationId = input.context.conversationId;
    if (!conversationId) {
      const [conversation] = await tx.select().from(conversations).where(and(
        eq(conversations.workspaceId, input.workspaceId),
        eq(conversations.contactId, lead.contactId),
        eq(conversations.status, "OPEN"),
      )).limit(1);
      conversationId = conversation?.id ?? null;
    }
    if (conversationId) {
      const [conversation] = await tx.select().from(conversations).where(and(
        eq(conversations.workspaceId, input.workspaceId),
        eq(conversations.id, conversationId),
      )).for("update").limit(1);
      if (conversation && conversation.assignedUserId !== input.action.userId) {
        await tx.update(conversations).set({
          assignedUserId: input.action.userId,
          updatedAt: new Date(),
        }).where(and(
          eq(conversations.workspaceId, input.workspaceId),
          eq(conversations.id, conversation.id),
        ));
        await tx.insert(conversationHandlingEvents).values({
          workspaceId: input.workspaceId,
          conversationId: conversation.id,
          type: "ASSIGNED",
          actorUserId: null,
          assignedUserId: input.action.userId,
          metadata: {
            automationRunId: input.runId,
            workflowActionRunId: input.actionRunId,
          },
        });
      }
    }

    await tx.update(workflowActionRuns).set({
      status: "COMPLETED",
      completedAt: new Date(),
      result: {
        leadId: lead.id,
        assignedUserId: input.action.userId,
        conversationId,
      },
      updatedAt: new Date(),
    }).where(and(
      eq(workflowActionRuns.workspaceId, input.workspaceId),
      eq(workflowActionRuns.id, input.actionRunId),
      eq(workflowActionRuns.status, "RUNNING"),
    ));
    return "COMPLETED" as const;
  });
}

async function executeNotifyStaff(input: {
  workspaceId: string;
  runId: string;
  actionRunId: string;
  action: Extract<WorkflowAction, { type: "NOTIFY_STAFF" }>;
  context: CustomerContext;
}) {
  return db.transaction(async tx => {
    const recipients = input.action.userId
      ? (await tx.select({ userId: memberships.userId }).from(memberships).where(and(
          eq(memberships.workspaceId, input.workspaceId),
          eq(memberships.userId, input.action.userId),
        ))).map(row => row.userId)
      : (await tx.select({ userId: memberships.userId }).from(memberships)
          .where(eq(memberships.workspaceId, input.workspaceId)))
        .map(row => row.userId);

    if (input.action.userId && recipients.length === 0) {
      throw new AppError(
        "WORKFLOW_STAFF_INVALID",
        "Configured notification recipient is no longer part of this workspace.",
        409,
      );
    }

    const recipientKey = input.action.userId ?? "workspace";
    const [delivery] = await tx.insert(automationDeliveries).values({
      workspaceId: input.workspaceId,
      runId: input.runId,
      actionRunId: input.actionRunId,
      channel: "IN_APP",
      recipient: recipientKey,
      status: recipients.length ? "SENT" : "SKIPPED",
      errorCode: recipients.length ? null : "NO_NOTIFICATION_RECIPIENTS",
      errorMessage: recipients.length ? null : "No current workspace member can receive this notification.",
    }).onConflictDoNothing().returning();

    if (!delivery) {
      const [existing] = await tx.select().from(automationDeliveries).where(and(
        eq(automationDeliveries.workspaceId, input.workspaceId),
        eq(automationDeliveries.runId, input.runId),
        eq(automationDeliveries.actionRunId, input.actionRunId),
        eq(automationDeliveries.channel, "IN_APP"),
        eq(automationDeliveries.recipient, recipientKey),
      )).limit(1);
      if (!existing || !["SENT", "SKIPPED"].includes(existing.status)) {
        throw new AppError(
          "WORKFLOW_NOTIFICATION_DELIVERY_CONFLICT",
          "Notification delivery is in an unsafe recovery state.",
          409,
        );
      }
      await tx.update(workflowActionRuns).set({
        status: existing.status === "SENT" ? "COMPLETED" : "SKIPPED",
        completedAt: new Date(),
        errorCode: existing.errorCode,
        errorMessage: existing.errorMessage,
        result: { recoveredDeliveryId: existing.id },
        updatedAt: new Date(),
      }).where(and(
        eq(workflowActionRuns.workspaceId, input.workspaceId),
        eq(workflowActionRuns.id, input.actionRunId),
        eq(workflowActionRuns.status, "RUNNING"),
      ));
      return existing.status === "SENT" ? "COMPLETED" as const : "SKIPPED" as const;
    }

    let firstNoticeId: string | null = null;
    if (recipients.length) {
      const notices = await tx.insert(notifications).values(recipients.map(userId => ({
        workspaceId: input.workspaceId,
        userId,
        type: "AUTOMATION_NOTIFICATION",
        title: input.action.title,
        body: input.action.message,
        conversationId: input.context.conversationId,
        contactId: input.context.contactId,
        metadata: {
          automationRunId: input.runId,
          workflowActionRunId: input.actionRunId,
        },
      }))).returning({ id: notifications.id });
      firstNoticeId = notices[0]?.id ?? null;
      await tx.update(automationDeliveries).set({
        providerExternalId: firstNoticeId,
        updatedAt: new Date(),
      }).where(eq(automationDeliveries.id, delivery.id));
    }

    await tx.update(workflowActionRuns).set({
      status: recipients.length ? "COMPLETED" : "SKIPPED",
      completedAt: new Date(),
      errorCode: recipients.length ? null : "NO_NOTIFICATION_RECIPIENTS",
      errorMessage: recipients.length ? null : "No current workspace member can receive this notification.",
      result: {
        deliveryId: delivery.id,
        notificationCount: recipients.length,
        firstNotificationId: firstNoticeId,
      },
      updatedAt: new Date(),
    }).where(and(
      eq(workflowActionRuns.workspaceId, input.workspaceId),
      eq(workflowActionRuns.id, input.actionRunId),
      eq(workflowActionRuns.status, "RUNNING"),
    ));
    return recipients.length ? "COMPLETED" as const : "SKIPPED" as const;
  });
}

const smsSuppressionCodes = new Set([
  "SMS_DESTINATION_REQUIRED",
  "SMS_IDENTITY_NOT_FOUND",
  "SMS_CAMPAIGN_NOT_APPROVED",
  "SMS_REGISTRATION_REQUIRED",
  "SMS_REGISTRATION_REJECTED",
  "SMS_CONSENT_REQUIRED",
]);

function classifySmsError(error: unknown): Exclude<WorkflowActionTerminalStatus, "COMPLETED"> {
  if (error instanceof AppError && smsSuppressionCodes.has(error.code)) return "SKIPPED";
  if (error instanceof AppError && error.code === "SMS_ACCEPTED_FINALIZATION_FAILED") return "UNKNOWN";
  if (error instanceof ProviderRequestError && error.status >= 400 && error.status < 500) return "FAILED";
  if (error instanceof AppError && error.status < 500) return "FAILED";
  return "UNKNOWN";
}

async function finishActionFromExistingDelivery(
  workspaceId: string,
  actionRunId: string,
  delivery: {
    id: string;
    status: "PENDING" | "SENT" | "SKIPPED" | "FAILED" | "UNKNOWN";
    errorCode: string | null;
    errorMessage: string | null;
    messageId: string | null;
    providerExternalId: string | null;
  },
): Promise<WorkflowActionTerminalStatus> {
  let current = delivery;
  if (current.status === "PENDING") {
    const reconciled = await finishPendingAutomationDelivery(workspaceId, current.id, {
      status: "UNKNOWN",
      errorCode: "INTERRUPTED_DELIVERY",
      errorMessage: "A prior worker stopped after claiming this SMS delivery; it was not retried to avoid a duplicate message.",
    });
    current = reconciled ?? await getAutomationDelivery(workspaceId, current.id) ?? current;
  }

  let status: WorkflowActionTerminalStatus;
  if (current.status === "SENT") status = "COMPLETED";
  else if (current.status === "SKIPPED") status = "SKIPPED";
  else if (current.status === "FAILED") status = "FAILED";
  else status = "UNKNOWN";

  await finishWorkflowActionRun(workspaceId, actionRunId, {
    status,
    errorCode: current.status === "UNKNOWN" && !current.errorCode
      ? "INTERRUPTED_DELIVERY"
      : current.errorCode,
    errorMessage: current.status === "UNKNOWN" && !current.errorMessage
      ? "A prior SMS attempt has an uncertain outcome and will not be resent automatically."
      : current.errorMessage,
    result: {
      deliveryId: current.id,
      messageId: current.messageId,
      providerExternalId: current.providerExternalId,
      recovered: true,
    },
  });
  return status;
}

async function executeCustomerSms(input: {
  workspaceId: string;
  runId: string;
  actionRunId: string;
  action: Extract<WorkflowAction, { type: "SEND_CUSTOMER_SMS" }>;
  context: CustomerContext;
}) {
  if (!input.context.conversationId) {
    await finishWorkflowActionRun(input.workspaceId, input.actionRunId, {
      status: "SKIPPED",
      errorCode: "SMS_CONVERSATION_UNAVAILABLE",
      errorMessage: "No current customer conversation is available for this workflow event.",
    });
    return "SKIPPED" as const;
  }

  const claimed = await claimAutomationDelivery({
    workspaceId: input.workspaceId,
    runId: input.runId,
    actionRunId: input.actionRunId,
    channel: "SMS",
    recipient: input.context.conversationId,
  });
  if (!claimed.created) {
    return finishActionFromExistingDelivery(input.workspaceId, input.actionRunId, claimed.delivery);
  }

  const text = renderTemplate(input.action.message, input.context.variables);
  try {
    const message = await sendSmsConversationText(input.workspaceId, input.context.conversationId, {
      senderType: "SYSTEM",
      text,
      idempotencyKey: claimed.delivery.id,
      metadata: {
        automationRunId: input.runId,
        workflowActionRunId: input.actionRunId,
      },
    });
    const finishedDelivery = await finishPendingAutomationDelivery(input.workspaceId, claimed.delivery.id, {
      status: "SENT",
      messageId: message.id,
      providerExternalId: message.externalMessageId,
    });
    if (!finishedDelivery) {
      const current = await getAutomationDelivery(input.workspaceId, claimed.delivery.id);
      if (!current) throw new AppError("AUTOMATION_DELIVERY_NOT_FOUND", "SMS delivery record disappeared.", 409);
      return finishActionFromExistingDelivery(input.workspaceId, input.actionRunId, current);
    }
    await finishWorkflowActionRun(input.workspaceId, input.actionRunId, {
      status: "COMPLETED",
      result: {
        deliveryId: finishedDelivery.id,
        messageId: message.id,
        providerExternalId: message.externalMessageId,
      },
    });
    return "COMPLETED" as const;
  } catch (error) {
    const status = classifySmsError(error);
    const errorCode = error instanceof AppError ? error.code : "SMS_DELIVERY_UNCERTAIN";
    const errorMessage = error instanceof Error ? error.message : "SMS delivery did not complete.";
    const finishedDelivery = await finishPendingAutomationDelivery(input.workspaceId, claimed.delivery.id, {
      status,
      errorCode,
      errorMessage,
    });
    if (!finishedDelivery) {
      const current = await getAutomationDelivery(input.workspaceId, claimed.delivery.id);
      if (!current) throw new AppError("AUTOMATION_DELIVERY_NOT_FOUND", "SMS delivery record disappeared.", 409);
      return finishActionFromExistingDelivery(input.workspaceId, input.actionRunId, current);
    }
    await finishWorkflowActionRun(input.workspaceId, input.actionRunId, {
      status,
      errorCode,
      errorMessage,
      result: { deliveryId: finishedDelivery.id },
    });
    return status;
  }
}

export async function executeWorkflowAction(input: {
  workspaceId: string;
  runId: string;
  actionRunId: string;
  actionType: string;
  action: WorkflowAction;
  event: AutomationEvent;
  context: CustomerContext;
}): Promise<WorkflowActionTerminalStatus> {
  if (input.actionType !== input.action.type) {
    await finishWorkflowActionRun(input.workspaceId, input.actionRunId, {
      status: "FAILED",
      errorCode: "WORKFLOW_ACTION_VERSION_MISMATCH",
      errorMessage: "Persisted action identity does not match the immutable workflow version.",
    });
    return "FAILED";
  }

  try {
    if (input.action.type === "ASSIGN_LEAD") {
      return await executeAssignLead({ ...input, action: input.action });
    }
    if (input.action.type === "NOTIFY_STAFF") {
      if (input.action.userId) await assertCurrentWorkspaceMember(input.workspaceId, input.action.userId);
      return await executeNotifyStaff({ ...input, action: input.action });
    }
    if (input.action.type === "SEND_CUSTOMER_SMS") {
      return await executeCustomerSms({ ...input, action: input.action });
    }
    await finishWorkflowActionRun(input.workspaceId, input.actionRunId, {
      status: "FAILED",
      errorCode: "WORKFLOW_ACTION_UNSUPPORTED",
      errorMessage: "Workflow action is not registered.",
    });
    return "FAILED";
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    await finishWorkflowActionRun(input.workspaceId, input.actionRunId, {
      status: "FAILED",
      errorCode: error.code,
      errorMessage: error.message,
    });
    return "FAILED";
  }
}
