import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  lt,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  appointments,
  contacts,
  conversationHandlingEvents,
  conversations,
  leads,
  messages,
  voiceCalls,
} from "@/db/schema";

export const dashboardDayOptions = [7, 30, 90] as const;
export type DashboardDays = (typeof dashboardDayOptions)[number];

export type DashboardMetric = {
  value: number;
  previousValue: number;
  changePercent: number | null;
};

export type DashboardSeriesPoint = {
  day: string;
  inquiries: number;
  aiConversations: number;
  qualifiedLeads: number;
  appointments: number;
  scheduledAppointments: number;
  completedAppointments: number;
  cancelledAppointments: number;
  humanTakeovers: number;
};

export type DashboardActivity = {
  id: string;
  kind: "INQUIRY" | "VOICE_CALL" | "LEAD_QUALIFIED" | "APPOINTMENT" | "HUMAN_TAKEOVER";
  label: string;
  detail: string;
  occurredAt: string;
  href: string;
};

type SummaryRow = {
  inquiries_current: number;
  inquiries_previous: number;
  ai_current: number;
  ai_previous: number;
  qualified_current: number;
  qualified_previous: number;
  appointments_current: number;
  appointments_previous: number;
  takeovers_current: number;
  takeovers_previous: number;
  credit_balance: number;
  credits_used: number;
};

function numberValue(value: unknown) {
  if (typeof value === "number") return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metric(current: unknown, previous: unknown): DashboardMetric {
  const value = numberValue(current);
  const previousValue = numberValue(previous);
  const changePercent = previousValue === 0
    ? (value === 0 ? 0 : null)
    : Math.round(((value - previousValue) / Math.abs(previousValue)) * 100);
  return { value, previousValue, changePercent };
}

function displayName(name: string | null, phone: string | null) {
  return name?.trim() || phone?.trim() || "Unknown customer";
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function enumerateUtcDays(start: Date, end: Date) {
  const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const days: string[] = [];
  for (let cursor = first; cursor <= last; cursor += 86_400_000) {
    days.push(dayKey(new Date(cursor)));
  }
  return days;
}

async function loadSummary(workspaceId: string, start: Date, end: Date, previousStart: Date) {
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM (
         SELECT conversation_id
           FROM messages
          WHERE workspace_id = ${workspaceId}
            AND direction = 'INBOUND'
            AND sender_type = 'CUSTOMER'
            AND created_at >= ${start}
            AND created_at < ${end}
          GROUP BY conversation_id
         UNION
         SELECT conversation_id
           FROM voice_calls
          WHERE workspace_id = ${workspaceId}
            AND answered_at IS NOT NULL
            AND started_at >= ${start}
            AND started_at < ${end}
          GROUP BY conversation_id
       ) current_inquiries) AS inquiries_current,
      (SELECT count(*)::int FROM (
         SELECT conversation_id
           FROM messages
          WHERE workspace_id = ${workspaceId}
            AND direction = 'INBOUND'
            AND sender_type = 'CUSTOMER'
            AND created_at >= ${previousStart}
            AND created_at < ${start}
          GROUP BY conversation_id
         UNION
         SELECT conversation_id
           FROM voice_calls
          WHERE workspace_id = ${workspaceId}
            AND answered_at IS NOT NULL
            AND started_at >= ${previousStart}
            AND started_at < ${start}
          GROUP BY conversation_id
       ) previous_inquiries) AS inquiries_previous,
      (SELECT count(*)::int FROM (
         SELECT conversation_id
           FROM messages
          WHERE workspace_id = ${workspaceId}
            AND sender_type = 'AI'
            AND created_at >= ${start}
            AND created_at < ${end}
          GROUP BY conversation_id
         UNION
         SELECT conversation_id
           FROM voice_calls
          WHERE workspace_id = ${workspaceId}
            AND started_at >= ${start}
            AND started_at < ${end}
          GROUP BY conversation_id
       ) current_ai) AS ai_current,
      (SELECT count(*)::int FROM (
         SELECT conversation_id
           FROM messages
          WHERE workspace_id = ${workspaceId}
            AND sender_type = 'AI'
            AND created_at >= ${previousStart}
            AND created_at < ${start}
          GROUP BY conversation_id
         UNION
         SELECT conversation_id
           FROM voice_calls
          WHERE workspace_id = ${workspaceId}
            AND started_at >= ${previousStart}
            AND started_at < ${start}
          GROUP BY conversation_id
       ) previous_ai) AS ai_previous,
      (SELECT count(*)::int
         FROM leads
        WHERE workspace_id = ${workspaceId}
          AND qualification_completed_at >= ${start}
          AND qualification_completed_at < ${end}) AS qualified_current,
      (SELECT count(*)::int
         FROM leads
        WHERE workspace_id = ${workspaceId}
          AND qualification_completed_at >= ${previousStart}
          AND qualification_completed_at < ${start}) AS qualified_previous,
      (SELECT count(*)::int
         FROM appointments
        WHERE workspace_id = ${workspaceId}
          AND created_at >= ${start}
          AND created_at < ${end}) AS appointments_current,
      (SELECT count(*)::int
         FROM appointments
        WHERE workspace_id = ${workspaceId}
          AND created_at >= ${previousStart}
          AND created_at < ${start}) AS appointments_previous,
      (SELECT count(DISTINCT conversation_id)::int
         FROM conversation_handling_events
        WHERE workspace_id = ${workspaceId}
          AND type IN ('TAKEOVER', 'ESCALATED')
          AND created_at >= ${start}
          AND created_at < ${end}) AS takeovers_current,
      (SELECT count(DISTINCT conversation_id)::int
         FROM conversation_handling_events
        WHERE workspace_id = ${workspaceId}
          AND type IN ('TAKEOVER', 'ESCALATED')
          AND created_at >= ${previousStart}
          AND created_at < ${start}) AS takeovers_previous,
      COALESCE((SELECT balance::int FROM credit_wallets WHERE workspace_id = ${workspaceId}), 0) AS credit_balance,
      COALESCE((SELECT sum(abs(amount))::int
                  FROM credit_ledger
                 WHERE workspace_id = ${workspaceId}
                   AND type = 'DEBIT'
                   AND created_at >= ${start}
                   AND created_at < ${end}), 0) AS credits_used
  `);

  return result.rows[0] as unknown as SummaryRow;
}

async function loadSeries(workspaceId: string, start: Date, end: Date): Promise<DashboardSeriesPoint[]> {
  const leadDay = sql<string>`to_char(${leads.qualificationCompletedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const appointmentDay = sql<string>`to_char(${appointments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const takeoverDay = sql<string>`to_char(${conversationHandlingEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

  const [inquiryRows, aiResult, leadRows, appointmentRows, takeoverRows] = await Promise.all([
    db.execute(sql`
      SELECT day, count(*)::int AS count
        FROM (
          SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, conversation_id
            FROM messages
           WHERE workspace_id = ${workspaceId}
             AND direction = 'INBOUND'
             AND sender_type = 'CUSTOMER'
             AND created_at >= ${start}
             AND created_at < ${end}
           GROUP BY day, conversation_id
          UNION
          SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, conversation_id
            FROM voice_calls
           WHERE workspace_id = ${workspaceId}
             AND answered_at IS NOT NULL
             AND started_at >= ${start}
             AND started_at < ${end}
           GROUP BY day, conversation_id
        ) daily_inquiries
       GROUP BY day
       ORDER BY day
    `),
    db.execute(sql`
      SELECT day, count(*)::int AS count
        FROM (
          SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, conversation_id
            FROM messages
           WHERE workspace_id = ${workspaceId}
             AND sender_type = 'AI'
             AND created_at >= ${start}
             AND created_at < ${end}
           GROUP BY day, conversation_id
          UNION
          SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, conversation_id
            FROM voice_calls
           WHERE workspace_id = ${workspaceId}
             AND started_at >= ${start}
             AND started_at < ${end}
           GROUP BY day, conversation_id
        ) daily_ai
       GROUP BY day
       ORDER BY day
    `),
    db.select({
      day: leadDay,
      count: sql<number>`count(*)::int`,
    }).from(leads)
      .where(and(
        eq(leads.workspaceId, workspaceId),
        isNotNull(leads.qualificationCompletedAt),
        gte(leads.qualificationCompletedAt, start),
        lt(leads.qualificationCompletedAt, end),
      ))
      .groupBy(leadDay),
    db.select({
      day: appointmentDay,
      total: sql<number>`count(*)::int`,
      scheduled: sql<number>`sum(case when ${appointments.status} in ('PENDING', 'CONFIRMED') then 1 else 0 end)::int`,
      completed: sql<number>`sum(case when ${appointments.status} = 'COMPLETED' then 1 else 0 end)::int`,
      cancelled: sql<number>`sum(case when ${appointments.status} = 'CANCELLED' then 1 else 0 end)::int`,
    }).from(appointments)
      .where(and(
        eq(appointments.workspaceId, workspaceId),
        gte(appointments.createdAt, start),
        lt(appointments.createdAt, end),
      ))
      .groupBy(appointmentDay),
    db.select({
      day: takeoverDay,
      count: sql<number>`count(distinct ${conversationHandlingEvents.conversationId})::int`,
    }).from(conversationHandlingEvents)
      .where(and(
        eq(conversationHandlingEvents.workspaceId, workspaceId),
        sql`${conversationHandlingEvents.type} in ('TAKEOVER', 'ESCALATED')`,
        gte(conversationHandlingEvents.createdAt, start),
        lt(conversationHandlingEvents.createdAt, end),
      ))
      .groupBy(takeoverDay),
  ]);

  const byDay = new Map<string, DashboardSeriesPoint>();
  for (const day of enumerateUtcDays(start, end)) {
    byDay.set(day, {
      day,
      inquiries: 0,
      aiConversations: 0,
      qualifiedLeads: 0,
      appointments: 0,
      scheduledAppointments: 0,
      completedAppointments: 0,
      cancelledAppointments: 0,
      humanTakeovers: 0,
    });
  }

  for (const row of inquiryRows.rows as Array<{ day: string; count: number }>) {
    const point = byDay.get(row.day);
    if (point) point.inquiries = numberValue(row.count);
  }
  for (const row of aiResult.rows as Array<{ day: string; count: number }>) {
    const point = byDay.get(row.day);
    if (point) point.aiConversations = numberValue(row.count);
  }
  for (const row of leadRows) {
    const point = byDay.get(row.day);
    if (point) point.qualifiedLeads = numberValue(row.count);
  }
  for (const row of appointmentRows) {
    const point = byDay.get(row.day);
    if (!point) continue;
    point.appointments = numberValue(row.total);
    point.scheduledAppointments = numberValue(row.scheduled);
    point.completedAppointments = numberValue(row.completed);
    point.cancelledAppointments = numberValue(row.cancelled);
  }
  for (const row of takeoverRows) {
    const point = byDay.get(row.day);
    if (point) point.humanTakeovers = numberValue(row.count);
  }

  return [...byDay.values()];
}

async function loadActivity(workspaceId: string, start: Date, end: Date): Promise<DashboardActivity[]> {
  const [inboundRows, voiceRows, leadRows, appointmentRows, handlingRows] = await Promise.all([
    db.select({
      id: messages.id,
      createdAt: messages.createdAt,
      channel: messages.channel,
      name: contacts.name,
      phone: contacts.phone,
      handlingMode: conversations.handlingMode,
    }).from(messages)
      .innerJoin(conversations, and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.id, messages.conversationId),
      ))
      .innerJoin(contacts, and(
        eq(contacts.workspaceId, workspaceId),
        eq(contacts.id, conversations.contactId),
      ))
      .where(and(
        eq(messages.workspaceId, workspaceId),
        eq(messages.direction, "INBOUND"),
        eq(messages.senderType, "CUSTOMER"),
        gte(messages.createdAt, start),
        lt(messages.createdAt, end),
      ))
      .orderBy(desc(messages.createdAt))
      .limit(5),
    db.select({
      id: voiceCalls.id,
      startedAt: voiceCalls.startedAt,
      name: contacts.name,
      phone: contacts.phone,
      status: voiceCalls.status,
    }).from(voiceCalls)
      .innerJoin(contacts, and(
        eq(contacts.workspaceId, workspaceId),
        eq(contacts.id, voiceCalls.contactId),
      ))
      .where(and(
        eq(voiceCalls.workspaceId, workspaceId),
        gte(voiceCalls.startedAt, start),
        lt(voiceCalls.startedAt, end),
      ))
      .orderBy(desc(voiceCalls.startedAt))
      .limit(5),
    db.select({
      id: leads.id,
      occurredAt: leads.qualificationCompletedAt,
      name: contacts.name,
      phone: contacts.phone,
    }).from(leads)
      .innerJoin(contacts, and(
        eq(contacts.workspaceId, workspaceId),
        eq(contacts.id, leads.contactId),
      ))
      .where(and(
        eq(leads.workspaceId, workspaceId),
        isNotNull(leads.qualificationCompletedAt),
        gte(leads.qualificationCompletedAt, start),
        lt(leads.qualificationCompletedAt, end),
      ))
      .orderBy(desc(leads.qualificationCompletedAt))
      .limit(5),
    db.select({
      id: appointments.id,
      occurredAt: appointments.createdAt,
      title: appointments.title,
      status: appointments.status,
      name: contacts.name,
      phone: contacts.phone,
    }).from(appointments)
      .innerJoin(contacts, and(
        eq(contacts.workspaceId, workspaceId),
        eq(contacts.id, appointments.contactId),
      ))
      .where(and(
        eq(appointments.workspaceId, workspaceId),
        gte(appointments.createdAt, start),
        lt(appointments.createdAt, end),
      ))
      .orderBy(desc(appointments.createdAt))
      .limit(5),
    db.select({
      id: conversationHandlingEvents.id,
      occurredAt: conversationHandlingEvents.createdAt,
      type: conversationHandlingEvents.type,
      reason: conversationHandlingEvents.reason,
      name: contacts.name,
      phone: contacts.phone,
    }).from(conversationHandlingEvents)
      .innerJoin(conversations, and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.id, conversationHandlingEvents.conversationId),
      ))
      .innerJoin(contacts, and(
        eq(contacts.workspaceId, workspaceId),
        eq(contacts.id, conversations.contactId),
      ))
      .where(and(
        eq(conversationHandlingEvents.workspaceId, workspaceId),
        sql`${conversationHandlingEvents.type} in ('TAKEOVER', 'ESCALATED')`,
        gte(conversationHandlingEvents.createdAt, start),
        lt(conversationHandlingEvents.createdAt, end),
      ))
      .orderBy(desc(conversationHandlingEvents.createdAt))
      .limit(5),
  ]);

  const items: DashboardActivity[] = [];

  for (const row of inboundRows) {
    const customer = displayName(row.name, row.phone);
    items.push({
      id: `message:${row.id}`,
      kind: "INQUIRY",
      label: `New ${row.channel === "WEBCHAT" ? "Web Chat" : row.channel} inquiry from ${customer}`,
      detail: row.handlingMode === "HUMAN" ? "Human handling" : "AI handling",
      occurredAt: row.createdAt.toISOString(),
      href: "/inbox",
    });
  }
  for (const row of voiceRows) {
    items.push({
      id: `voice:${row.id}`,
      kind: "VOICE_CALL",
      label: `Inbound call from ${displayName(row.name, row.phone)}`,
      detail: row.status === "FAILED" ? "Call failed" : "Voice",
      occurredAt: row.startedAt.toISOString(),
      href: "/inbox",
    });
  }
  for (const row of leadRows) {
    if (!row.occurredAt) continue;
    items.push({
      id: `lead:${row.id}`,
      kind: "LEAD_QUALIFIED",
      label: `Lead qualified: ${displayName(row.name, row.phone)}`,
      detail: "Qualified",
      occurredAt: row.occurredAt.toISOString(),
      href: "/contacts",
    });
  }
  for (const row of appointmentRows) {
    items.push({
      id: `appointment:${row.id}`,
      kind: "APPOINTMENT",
      label: `Appointment booked for ${displayName(row.name, row.phone)}`,
      detail: row.title,
      occurredAt: row.occurredAt.toISOString(),
      href: "/appointments",
    });
  }
  for (const row of handlingRows) {
    items.push({
      id: `handling:${row.id}`,
      kind: "HUMAN_TAKEOVER",
      label: `Human takeover: ${displayName(row.name, row.phone)}`,
      detail: row.reason?.trim() || (row.type === "ESCALATED" ? "AI escalation" : "Team takeover"),
      occurredAt: row.occurredAt.toISOString(),
      href: "/inbox",
    });
  }

  return items
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 5);
}

async function loadAttention(workspaceId: string, now: Date) {
  const staleBefore = new Date(now.getTime() - 30 * 60_000);
  const nextDay = new Date(now.getTime() + 24 * 60 * 60_000);
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*)::int
         FROM (
           SELECT DISTINCT ON (m.conversation_id)
                  m.conversation_id,
                  m.created_at AS inbound_at
             FROM messages m
            WHERE m.workspace_id = ${workspaceId}
              AND m.direction = 'INBOUND'
              AND m.sender_type = 'CUSTOMER'
            ORDER BY m.conversation_id, m.created_at DESC
         ) latest
         JOIN conversations c
           ON c.id = latest.conversation_id
          AND c.workspace_id = ${workspaceId}
        WHERE c.status = 'OPEN'
          AND latest.inbound_at < ${staleBefore}
          AND NOT EXISTS (
            SELECT 1
              FROM messages reply
             WHERE reply.workspace_id = ${workspaceId}
               AND reply.conversation_id = latest.conversation_id
               AND reply.direction = 'OUTBOUND'
               AND reply.created_at > latest.inbound_at
          )) AS unanswered_inquiries,
      (SELECT count(*)::int
         FROM appointments
        WHERE workspace_id = ${workspaceId}
          AND status = 'PENDING'
          AND starts_at >= ${now}
          AND starts_at < ${nextDay}) AS pending_appointments,
      (SELECT count(*)::int
         FROM leads l
        WHERE l.workspace_id = ${workspaceId}
          AND l.status = 'QUALIFIED'
          AND NOT EXISTS (
            SELECT 1
              FROM appointments a
             WHERE a.workspace_id = ${workspaceId}
               AND a.contact_id = l.contact_id
               AND a.status IN ('PENDING', 'CONFIRMED', 'COMPLETED')
          )) AS qualified_followups
  `);
  const row = result.rows[0] as unknown as {
    unanswered_inquiries: number;
    pending_appointments: number;
    qualified_followups: number;
  };
  return {
    unansweredInquiries: numberValue(row.unanswered_inquiries),
    pendingAppointments: numberValue(row.pending_appointments),
    qualifiedFollowups: numberValue(row.qualified_followups),
  };
}

export async function getDashboardOverview(
  workspaceId: string,
  days: DashboardDays = 30,
  now = new Date(),
) {
  const end = new Date(now);
  const start = new Date(end.getTime() - days * 86_400_000);
  const previousStart = new Date(start.getTime() - days * 86_400_000);

  const [summary, series, activity, attention] = await Promise.all([
    loadSummary(workspaceId, start, end, previousStart),
    loadSeries(workspaceId, start, end),
    loadActivity(workspaceId, start, end),
    loadAttention(workspaceId, end),
  ]);

  const scheduledAppointments = series.reduce((total, point) => total + point.scheduledAppointments, 0);
  const completedAppointments = series.reduce((total, point) => total + point.completedAppointments, 0);
  const cancelledAppointments = series.reduce((total, point) => total + point.cancelledAppointments, 0);

  return {
    range: {
      days,
      start: start.toISOString(),
      end: end.toISOString(),
    },
    metrics: {
      inquiries: metric(summary.inquiries_current, summary.inquiries_previous),
      aiConversations: metric(summary.ai_current, summary.ai_previous),
      qualifiedLeads: metric(summary.qualified_current, summary.qualified_previous),
      appointments: metric(summary.appointments_current, summary.appointments_previous),
      humanTakeovers: metric(summary.takeovers_current, summary.takeovers_previous),
    },
    credit: {
      balance: numberValue(summary.credit_balance),
      usedInPeriod: numberValue(summary.credits_used),
    },
    appointmentStatus: {
      scheduled: scheduledAppointments,
      completed: completedAppointments,
      cancelled: cancelledAppointments,
    },
    series,
    activity,
    attention,
  };
}
