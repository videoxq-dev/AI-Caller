import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { workspaces } from "@/db/schema";
import {
  appendMessage,
  createContact,
  getContactDetail,
  getConversationTimeline,
  getOrCreateOpenConversation,
  setConversationHandlingMode,
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

  it("keeps SMS and WhatsApp events in one conversation timeline", async () => {
    const contact = await createContact(workspaceId, {
      name: "Grace Hopper",
      email: null,
      phone: "+15550001111",
      notes: null,
      tags: [],
      identities: [],
    });

    const [first, second] = await Promise.all([
      getOrCreateOpenConversation(workspaceId, contact.id),
      getOrCreateOpenConversation(workspaceId, contact.id),
    ]);

    expect(first.id).toBe(second.id);

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
});
