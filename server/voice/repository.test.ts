import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { workspaces } from "@/db/schema";
import { createContact, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import {
  appendVoiceTranscriptSegment,
  createVoiceCall,
  getVoiceCallWithTranscript,
} from "./repository";

describe("voice transcript repository", () => {
  let workspaceId = "";
  let callId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Transcript order" }).returning();
    workspaceId = workspace.id;
    const contact = await createContact(workspaceId, {
      name: "Caller", email: null, phone: "+13074453684", notes: null,
      tags: [], identities: [],
    });
    const conversation = await getOrCreateOpenConversation(workspaceId, contact.id);
    const call = await createVoiceCall(workspaceId, {
      conversationId: conversation.id,
      contactId: contact.id,
      integrationId: null,
      provider: "telnyx",
      externalCallId: "call-order",
      callControlId: "control-order",
      fromNumber: "+13074453684",
      toNumber: "+13075550100",
      mode: "AI_FIRST",
    });
    callId = call.id;
  });

  afterAll(async () => closeDatabase());

  it("returns mixed caller and Realtime AI segments in persisted sequence order", async () => {
    await appendVoiceTranscriptSegment(workspaceId, callId, {
      speaker: "CUSTOMER", text: "I want to book.", startedMs: 14_000, endedMs: 16_000,
      externalEventId: "caller-1",
    });
    await appendVoiceTranscriptSegment(workspaceId, callId, {
      speaker: "AI", text: "What date works?", externalEventId: "ai-1",
    });
    await appendVoiceTranscriptSegment(workspaceId, callId, {
      speaker: "CUSTOMER", text: "September 23.", startedMs: 45_000, endedMs: 47_000,
      externalEventId: "caller-2",
    });
    await appendVoiceTranscriptSegment(workspaceId, callId, {
      speaker: "AI", text: "I will check that time.", externalEventId: "ai-2",
    });

    const result = await getVoiceCallWithTranscript(workspaceId, callId);

    expect(result?.transcript.map((segment) => `${segment.speaker}:${segment.text}`)).toEqual([
      "CUSTOMER:I want to book.",
      "AI:What date works?",
      "CUSTOMER:September 23.",
      "AI:I will check that time.",
    ]);
  });
});
