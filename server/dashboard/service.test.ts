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
  voiceCalls,
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
    expect(result.series.reduce((sum, point) => sum + point.inquiries, 0)).toBe(result.metrics.inquiries.value);
    expect(result.series.reduce((sum, point) => sum + point.aiConversations, 0)).toBe(result.metrics.aiConversations.value);
    expect(result.series.reduce((sum, point) => sum + point.humanTakeovers, 0)).toBe(result.metrics.humanTakeovers.value);
  });

  it("counts missed voice calls as inquiries but only answered calls as AI conversations", async () => {
    const [missedContact, answeredContact] = await db.insert(contacts).values([
      { workspaceId, name: "Missed Caller", phone: "+12025550110" },
      { workspaceId, name: "Answered Caller", phone: "+12025550111" },
    ]).returning();
    const [missedConversation, answeredConversation] = await db.insert(conversations).values([
      { workspaceId, contactId: missedContact.id, createdAt: new Date("2026-09-18T09:00:00.000Z") },
      { workspaceId, contactId: answeredContact.id, createdAt: new Date("2026-09-18T10:00:00.000Z") },
    ]).returning();

    await db.insert(voiceCalls).values([
      {
        workspaceId,
        conversationId: missedConversation.id,
        contactId: missedContact.id,
        integrationId: null,
        provider: "telnyx",
        externalCallId: "dashboard-missed-call",
        callControlId: "dashboard-missed-control",
        fromNumber: "+12025550110",
        toNumber: "+12025550999",
        mode: "AI_FIRST",
        status: "FAILED",
        startedAt: new Date("2026-09-18T09:00:00.000Z"),
      },
      {
        workspaceId,
        conversationId: answeredConversation.id,
        contactId: answeredContact.id,
        integrationId: null,
        provider: "telnyx",
        externalCallId: "dashboard-answered-call",
        callControlId: "dashboard-answered-control",
        fromNumber: "+12025550111",
        toNumber: "+12025550999",
        mode: "AI_FIRST",
        status: "COMPLETED",
        startedAt: new Date("2026-09-18T10:00:00.000Z"),
        answeredAt: new Date("2026-09-18T10:00:05.000Z"),
        endedAt: new Date("2026-09-18T10:04:00.000Z"),
      },
    ]);

    const result = await getDashboardOverview(workspaceId, 7, now);

    expect(result.metrics.inquiries.value).toBe(2);
    expect(result.metrics.aiConversations.value).toBe(1);
    expect(result.series.reduce((sum, point) => sum + point.inquiries, 0)).toBe(2);
    expect(result.series.reduce((sum, point) => sum + point.aiConversations, 0)).toBe(1);
  });

  it("does not flag a qualified lead after an outbound follow-up", async () => {
    const [contact] = await db.insert(contacts).values({
      workspaceId,
      name: "Followed Up Customer",
      phone: "+12025550112",
    }).returning();
    const [conversation] = await db.insert(conversations).values({
      workspaceId,
      contactId: contact.id,
      createdAt: new Date("2026-09-18T09:00:00.000Z"),
      lastMessageAt: new Date("2026-09-18T09:20:00.000Z"),
    }).returning();

    await db.insert(leads).values({
      workspaceId,
      contactId: contact.id,
      status: "QUALIFIED",
      qualificationScore: 95,
      qualificationCompletedAt: new Date("2026-09-18T09:10:00.000Z"),
    });
    await db.insert(messages).values({
      workspaceId,
      conversationId: conversation.id,
      channel: "SMS",
      direction: "OUTBOUND",
      senderType: "USER",
      body: "Following up on your request.",
      provider: "fixture",
      externalMessageId: "dashboard-followup-outbound",
      status: "SENT",
      createdAt: new Date("2026-09-18T09:20:00.000Z"),
    });

    const result = await getDashboardOverview(workspaceId, 7, now);

    expect(result.attention.qualifiedFollowups).toBe(0);
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
