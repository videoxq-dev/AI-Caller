import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { appointments, automationEvents, contacts, workspaces } from "@/db/schema";
import {
  appendMessage,
  createContact,
  getContactDetail,
  getConversationTimeline,
  getOrCreateContactByIdentity,
  getOrCreateOpenConversation,
  setConversationHandlingMode,
  setAppointmentStatus,
  updateAppointmentAfterReschedule,
} from "./repository";

describe("core domain persistence", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Core Domain Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("stores multiple channel identities on one contact", async () => {
    const contact = await createContact(workspaceId, {
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+15551234567",
      notes: null,
      tags: ["VIP"],
      identities: [
        { channel: "SMS", externalId: "+1 555 123 4567", normalizedValue: "+15551234567" },
        { channel: "WHATSAPP", externalId: "15551234567", normalizedValue: "+15551234567" },
      ],
    });

    const detail = await getContactDetail(workspaceId, contact.id);

    expect(detail?.identities).toHaveLength(2);
    expect(detail?.identities.map((identity) => identity.channel).sort()).toEqual(["SMS", "WHATSAPP"]);
    expect(detail?.tags).toEqual(["VIP"]);
  });

  it("resolves concurrent identity creation to one contact", async () => {
    const contacts = await Promise.all(Array.from({ length: 8 }, () => getOrCreateContactByIdentity(workspaceId, {
      channel: "SMS",
      externalId: "+1 (555) 400-5000",
      name: "Concurrent Contact",
    })));

    expect(new Set(contacts.map((contact) => contact.id)).size).toBe(1);
  });

  it("keeps SMS and WhatsApp events in one conversation timeline", async () => {
    const contact = await createContact(workspaceId, {
      name: "Grace Hopper",
      email: null,
      phone: "+15550001111",
      notes: null,
      tags: [],
      identities: [],
    });

    const openConversations = await Promise.all(Array.from(
      { length: 8 },
      () => getOrCreateOpenConversation(workspaceId, contact.id),
    ));
    const [first] = openConversations;

    expect(first).toBeDefined();
    expect(new Set(openConversations.map((conversation) => conversation.id)).size).toBe(1);

    await appendMessage(workspaceId, first.id, {
      channel: "SMS",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentType: "TEXT",
      body: "Can I book tomorrow?",
      provider: "twilio",
      externalMessageId: "sms-1",
      status: "received",
      metadata: {},
    });

    await appendMessage(workspaceId, first.id, {
      channel: "WHATSAPP",
      direction: "OUTBOUND",
      senderType: "AI",
      contentType: "TEXT",
      body: "Yes. What time works best?",
      provider: "meta",
      externalMessageId: "wa-1",
      status: "sent",
      metadata: {},
    });

    const timeline = await getConversationTimeline(workspaceId, first.id);

    expect(timeline?.messages.map((message) => message.channel)).toEqual(["SMS", "WHATSAPP"]);
    expect(timeline?.conversation.lastMessageAt).not.toBeNull();
  });

  it("supports human takeover and returning control to AI", async () => {
    const contact = await createContact(workspaceId, {
      name: "Katherine Johnson",
      email: null,
      phone: null,
      notes: null,
      tags: [],
      identities: [{ channel: "WEBCHAT", externalId: "session-123", normalizedValue: "session-123" }],
    });
    const conversation = await getOrCreateOpenConversation(workspaceId, contact.id);

    const human = await setConversationHandlingMode(workspaceId, conversation.id, "HUMAN", null);
    expect(human.handlingMode).toBe("HUMAN");
    expect(human.aiPausedAt).not.toBeNull();

    const ai = await setConversationHandlingMode(workspaceId, conversation.id, "AI", null);
    expect(ai.handlingMode).toBe("AI");
    expect(ai.aiPausedAt).toBeNull();
  });

  it("records distinct committed reschedules when an appointment moves A to B and back to A", async () => {
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Reschedule Customer" }).returning();
    const startsAt = new Date("2037-10-02T14:00:00.000Z");
    const [appointment] = await db.insert(appointments).values({
      workspaceId, contactId: contact.id, title: "Cleaning", timezone: "UTC",
      startsAt, endsAt: new Date("2037-10-02T15:00:00.000Z"), status: "CONFIRMED",
    }).returning();

    await updateAppointmentAfterReschedule(workspaceId, appointment.id, {
      startsAt: new Date("2037-10-03T14:00:00.000Z"),
      endsAt: new Date("2037-10-03T15:00:00.000Z"),
      timezone: "UTC",
    });
    await updateAppointmentAfterReschedule(workspaceId, appointment.id, {
      startsAt, endsAt: new Date("2037-10-02T15:00:00.000Z"), timezone: "UTC",
    });

    const events = await db.select().from(automationEvents);
    expect(events).toHaveLength(2);
    expect(events.every(event =>
      event.type === "APPOINTMENT_RESCHEDULED" && event.aggregateId === appointment.id,
    )).toBe(true);
    expect(new Set(events.map(event => event.occurrenceKey)).size).toBe(2);
    expect(events.map(event => event.payload.startsAt).sort()).toEqual([
      "2037-10-02T14:00:00.000Z", "2037-10-03T14:00:00.000Z",
    ]);
    const [stored] = await db.select().from(appointments);
    expect(stored.id).toBe(appointment.id);
    expect(stored.startsAt).toEqual(startsAt);
  });

  it("emits cancellation only on a real transition, including concurrent retries", async () => {
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Cancellation Customer" }).returning();
    const [appointment] = await db.insert(appointments).values({
      workspaceId, contactId: contact.id, title: "Cleaning", timezone: "UTC",
      startsAt: new Date("2037-10-02T14:00:00.000Z"),
      endsAt: new Date("2037-10-02T15:00:00.000Z"),
      status: "CONFIRMED",
    }).returning();

    const [first, second] = await Promise.all([
      setAppointmentStatus(workspaceId, appointment.id, "CANCELLED"),
      setAppointmentStatus(workspaceId, appointment.id, "CANCELLED"),
    ]);
    expect(first.status).toBe("CANCELLED");
    expect(second.status).toBe("CANCELLED");
    expect((await db.select().from(automationEvents))).toHaveLength(1);

    await setAppointmentStatus(workspaceId, appointment.id, "CONFIRMED");
    await setAppointmentStatus(workspaceId, appointment.id, "CANCELLED");
    const events = await db.select().from(automationEvents);
    expect(events).toHaveLength(2);
    expect(new Set(events.map(event => event.occurrenceKey)).size).toBe(2);
    expect(events.every(event => event.type === "APPOINTMENT_CANCELLED")).toBe(true);
  });
});
