import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { messages, workspaces } from "@/db/schema";
import {
  appendMessage,
  getOrCreateContactByIdentity,
  getOrCreateOpenConversation,
} from "@/server/domain/core/repository";
import { updateWhatsAppDeliveryStatus } from "./repository";

describe("WhatsApp delivery reconciliation", () => {
  let workspaceId = "";
  let messageId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "WhatsApp Delivery Test" }).returning();
    workspaceId = workspace.id;
    const contact = await getOrCreateContactByIdentity(workspaceId, {
      channel: "WHATSAPP",
      externalId: "15551110000",
    });
    const conversation = await getOrCreateOpenConversation(workspaceId, contact.id);
    const message = await appendMessage(workspaceId, conversation.id, {
      channel: "WHATSAPP",
      direction: "OUTBOUND",
      senderType: "AI",
      contentType: "TEXT",
      body: "Hello",
      provider: "whatsapp",
      externalMessageId: "wamid.delivery-order",
      status: "SENT",
      metadata: {},
    });
    messageId = message.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("ignores an older failed callback that arrives after a newer delivered callback", async () => {
    const deliveredAt = new Date("2026-09-17T20:00:10.000Z");
    const staleFailureAt = new Date("2026-09-17T20:00:05.000Z");

    await updateWhatsAppDeliveryStatus(workspaceId, "wamid.delivery-order", "DELIVERED", null, deliveredAt);
    await updateWhatsAppDeliveryStatus(workspaceId, "wamid.delivery-order", "FAILED", "stale failure", staleFailureAt);

    const [stored] = await db.select().from(messages);
    expect(stored).toMatchObject({ id: messageId, status: "DELIVERED" });
    expect(stored.metadata).toMatchObject({ whatsappStatusAt: deliveredAt.toISOString() });
    expect(stored.metadata).not.toHaveProperty("deliveryError");
  });

  it("keeps READ as the terminal success state under concurrent status callbacks", async () => {
    const occurredAt = new Date("2026-09-17T20:01:00.000Z");
    const callbacks = Array.from({ length: 24 }, (_, index) => {
      const status = index % 3 === 0 ? "READ" : index % 3 === 1 ? "DELIVERED" : "SENT";
      return updateWhatsAppDeliveryStatus(workspaceId, "wamid.delivery-order", status, null, occurredAt);
    });

    await Promise.all(callbacks);

    const [stored] = await db.select().from(messages);
    expect(stored).toMatchObject({ id: messageId, status: "READ" });
    expect(stored.metadata).toMatchObject({ whatsappStatusAt: occurredAt.toISOString() });
  });
});