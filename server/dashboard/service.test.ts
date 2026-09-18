import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  appointments,
  contacts,
  conversationHandlingEvents,
  conversations,
  creditLedger,
  creditWallets,
  leads,
  messages,
  workspaces,
} from "@/db/schema";
import { getDashboardOverview } from "./service";

describe("dashboard aggregation", () => {
  let workspaceId = "";
  const now = new Date("2026-09-18T12:00:00.000Z");

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Dashboard Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("returns live workspace metrics, trends, activity, attention, and credit usage", async () => {
    const [currentContact, staleContact, followupContact, previousContact] = await db.insert(contacts).values([
      { workspaceId, name: "Current Customer", phone: "+12025550101" },
      { workspaceId, name: "Waiting Customer", phone: "+12025550102" },
      { workspaceId, name: "Qualified Customer", phone: "+12025550103" },
      { workspaceId, name: "Previous Customer", phone: "+12025550104" },
    ]).returning();

    const [currentConversation] = await db.insert(conversations).values({
      workspaceId,
      contactId: currentContact.id,
      createdAt: new Date("2026-09-17T09:00:00.000Z"),
      lastMessageAt: new Date("2026-09-17T09:05:00.000Z"),
    }).returning();
    const [staleConversation] = await db.insert(conversations).values({
      workspaceId,
      contactId: staleContact.id,
      createdAt: new Date("2026-09-17T08:00:00.000Z"),
      lastMessageAt: new Date("2026-09-18T10:00:00.000Z"),
    }).returning();
    const [previousConversation] = await db.insert(conversations).values({
      workspaceId,
      contactId: previousContact.id,
      createdAt: new Date("2026-09-08T09:00:00.000Z"),
      lastMessageAt: new Date("2026-09-08T09:05:00.000Z"),
    }).returning();

    await db.insert(messages).values([
      {
        workspaceId,
        conversationId: currentConversation.id,
        channel: "SMS",
        direction: "INBOUND",
        senderType: "CUSTOMER",
        body: "Can I book?",
        provider: "fixture",
        externalMessageId: "dashboard-current-inbound",
        status: "RECEIVED",
        createdAt: new Date("2026-09-17T09:00:00.000Z"),
      },
      {
        workspaceId,
        conversationId: currentConversation.id,
        channel: "SMS",
        direction: "OUTBOUND",
        senderType: "AI",
        body: "Absolutely.",
        provider: "fixture",
        externalMessageId: "dashboard-current-ai",
        status: "SENT",
        createdAt: new Date("2026-09-17T09:05:00.000Z"),
      },
      {
        workspaceId,
        conversationId: staleConversation.id,
        channel: "WHATSAPP",
        direction: "INBOUND",
        senderType: "CUSTOMER",
        body: "Still there?",
        provider: "fixture",
        externalMessageId: "dashboard-stale-inbound",
        status: "RECEIVED",
        createdAt: new Date("2026-09-18T10:00:00.000Z"),
      },
      {
        workspaceId,
        conversationId: previousConversation.id,
        channel: "SMS",
        direction: "INBOUND",
        senderType: "CUSTOMER",
        body: "Previous inquiry",
        provider: "fixture",
        externalMessageId: "dashboard-previous-inbound",
        status: "RECEIVED",
        createdAt: new Date("2026-09-08T09:00:00.000Z"),
      },
      {
        workspaceId,
        conversationId: previousConversation.id,
        channel: "SMS",
        direction: "OUTBOUND",
        senderType: "AI",
        body: "Previous response",
        provider: "fixture",
        externalMessageId: "dashboard-previous-ai",
        status: "SENT",
        createdAt: new Date("2026-09-08T09:05:00.000Z"),
      },
    ]);

    await db.insert(leads).values([
      {
        workspaceId,
        contactId: currentContact.id,
        status: "QUALIFIED",
        qualificationScore: 90,
        qualificationCompletedAt: new Date("2026-09-17T09:10:00.000Z"),
      },
      {
        workspaceId,
        contactId: followupContact.id,
        status: "QUALIFIED",
        qualificationScore: 80,
        qualificationCompletedAt: new Date("2026-09-16T14:00:00.000Z"),
      },
      {
        workspaceId,
        contactId: previousContact.id,
        status: "BOOKED",
        qualificationScore: 85,
        qualificationCompletedAt: new Date("2026-09-08T09:10:00.000Z"),
      },
    ]);

    await db.insert(appointments).values([
      {
        workspaceId,
        contactId: currentContact.id,
        conversationId: currentConversation.id,
        title: "Consultation",
        startsAt: new Date("2026-09-18T13:00:00.000Z"),
        endsAt: new Date("2026-09-18T13:30:00.000Z"),
        timezone: "UTC",
        status: "PENDING",
        bookingSource: "TEST",
        createdAt: new Date("2026-09-17T09:20:00.000Z"),
      },
      {
        workspaceId,
        contactId: previousContact.id,
        conversationId: previousConversation.id,
        title: "Previous consultation",
        startsAt: new Date("2026-09-09T13:00:00.000Z"),
        endsAt: new Date("2026-09-09T13:30:00.000Z"),
        timezone: "UTC",
        status: "COMPLETED",
        bookingSource: "TEST",
        createdAt: new Date("2026-09-08T09:20:00.000Z"),
      },
    ]);

    await db.insert(conversationHandlingEvents).values([
      {
        workspaceId,
        conversationId: currentConversation.id,
        type: "TAKEOVER",
        reason: "Pricing question",
        createdAt: new Date("2026-09-17T09:30:00.000Z"),
      },
      {
        workspaceId,
        conversationId: previousConversation.id,
        type: "ESCALATED",
        reason: "Previous escalation",
        createdAt: new Date("2026-09-08T09:30:00.000Z"),
      },
    ]);

    await db.insert(creditWallets).values({ workspaceId, balance: 80 });
    await db.insert(creditLedger).values({
      workspaceId,
      type: "DEBIT",
      amount: -20,
      balanceAfter: 80,
      reason: "Dashboard test usage",
      referenceType: "TEST",
      referenceId: "dashboard-usage",
      createdAt: new Date("2026-09-17T10:00:00.000Z"),
    });

    const result = await getDashboardOverview(workspaceId, 7, now);

    expect(result.metrics.inquiries).toMatchObject({ value: 2, previousValue: 1, changePercent: 100 });
    expect(result.metrics.aiConversations).toMatchObject({ value: 1, previousValue: 1, changePercent: 0 });
    expect(result.metrics.qualifiedLeads).toMatchObject({ value: 2, previousValue: 1, changePercent: 100 });
    expect(result.metrics.appointments).toMatchObject({ value: 1, previousValue: 1, changePercent: 0 });
    expect(result.metrics.humanTakeovers).toMatchObject({ value: 1, previousValue: 1, changePercent: 0 });
    expect(result.credit).toEqual({ balance: 80, usedInPeriod: 20 });
    expect(result.appointmentStatus).toEqual({ scheduled: 1, completed: 0, cancelled: 0 });
    expect(result.attention).toEqual({
      unansweredInquiries: 1,
      pendingAppointments: 1,
      qualifiedFollowups: 1,
    });
    expect(result.activity.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "INQUIRY",
      "LEAD_QUALIFIED",
      "APPOINTMENT",
      "HUMAN_TAKEOVER",
    ]));
    expect(result.series.some((point) => point.inquiries === 2)).toBe(true);
  });

  it("never mixes records from another workspace", async () => {
    const [foreignWorkspace] = await db.insert(workspaces).values({ name: "Other Workspace" }).returning();
    const [foreignContact] = await db.insert(contacts).values({
      workspaceId: foreignWorkspace.id,
      name: "Foreign Customer",
    }).returning();
    await db.insert(conversations).values({
      workspaceId: foreignWorkspace.id,
      contactId: foreignContact.id,
      createdAt: new Date("2026-09-17T09:00:00.000Z"),
    });
    await db.insert(creditWallets).values({ workspaceId: foreignWorkspace.id, balance: 999 });

    const result = await getDashboardOverview(workspaceId, 7, now);

    expect(result.metrics.inquiries.value).toBe(0);
    expect(result.credit.balance).toBe(0);
    expect(result.activity).toEqual([]);
  });
});
