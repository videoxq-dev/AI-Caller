import { and, asc, eq, max, sql } from "drizzle-orm";
import { db } from "@/db";
import { voiceCalls, voiceTranscriptSegments } from "@/db/schema";
import { AppError } from "@/server/http/errors";

export type CreateVoiceCallInput = {
  conversationId: string;
  contactId: string;
  integrationId: string | null;
  provider: string;
  externalCallId: string;
  callControlId: string;
  fromNumber: string;
  toNumber: string;
  mode: "AI_FIRST" | "AFTER_HOURS" | "OVERFLOW";
  recordingDisclosureVersion?: string | null;
  metadata?: Record<string, unknown>;
};

type VoiceCallPatch = Partial<Pick<typeof voiceCalls.$inferInsert,
  | "callControlId"
  | "status"
  | "answeredAt"
  | "endedAt"
  | "durationSeconds"
  | "recordingStatus"
  | "recordingExternalId"
  | "recordingObjectKey"
  | "recordingMimeType"
  | "recordingDurationSeconds"
  | "recordingConsentStatus"
  | "recordingDisclosureVersion"
  | "recordingDisclosedAt"
  | "transcriptStatus"
>>;

export async function getVoiceCallByExternalId(workspaceId: string, provider: string, externalCallId: string) {
  const [row] = await db.select().from(voiceCalls).where(and(
    eq(voiceCalls.workspaceId, workspaceId),
    eq(voiceCalls.provider, provider),
    eq(voiceCalls.externalCallId, externalCallId),
  )).limit(1);
  return row ?? null;
}

export async function createVoiceCall(workspaceId: string, input: CreateVoiceCallInput) {
  const [created] = await db.insert(voiceCalls).values({
    workspaceId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    integrationId: input.integrationId,
    provider: input.provider,
    externalCallId: input.externalCallId,
    callControlId: input.callControlId,
    fromNumber: input.fromNumber,
    toNumber: input.toNumber,
    mode: input.mode,
    recordingDisclosureVersion: input.recordingDisclosureVersion ?? null,
    metadata: input.metadata ?? {},
  }).onConflictDoNothing().returning();

  if (created) return created;
  const existing = await getVoiceCallByExternalId(workspaceId, input.provider, input.externalCallId);
  if (!existing) throw new AppError("VOICE_CALL_CONFLICT", "The inbound voice call could not be resolved.", 409);
  return existing;
}

export async function updateVoiceCall(
  workspaceId: string,
  callId: string,
  patch: VoiceCallPatch,
  metadataPatch?: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${callId}))`);
    const [existing] = await tx.select().from(voiceCalls).where(and(
      eq(voiceCalls.workspaceId, workspaceId),
      eq(voiceCalls.id, callId),
    )).limit(1);
    if (!existing) throw new AppError("VOICE_CALL_NOT_FOUND", "Voice call not found.", 404);

    const [updated] = await tx.update(voiceCalls).set({
      ...patch,
      ...(metadataPatch ? { metadata: { ...existing.metadata, ...metadataPatch } } : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(voiceCalls.workspaceId, workspaceId),
      eq(voiceCalls.id, callId),
    )).returning();
    return updated;
  });
}

export async function getVoiceCall(workspaceId: string, callId: string) {
  const [row] = await db.select().from(voiceCalls).where(and(
    eq(voiceCalls.workspaceId, workspaceId),
    eq(voiceCalls.id, callId),
  )).limit(1);
  return row ?? null;
}

export async function getVoiceCallWithTranscript(workspaceId: string, callId: string) {
  const call = await getVoiceCall(workspaceId, callId);
  if (!call) return null;
  const transcript = await db.select().from(voiceTranscriptSegments).where(and(
    eq(voiceTranscriptSegments.workspaceId, workspaceId),
    eq(voiceTranscriptSegments.voiceCallId, callId),
  )).orderBy(asc(voiceTranscriptSegments.sequence)).limit(2000);
  return { call, transcript };
}

export async function appendVoiceTranscriptSegment(
  workspaceId: string,
  callId: string,
  input: {
    speaker: "CUSTOMER" | "AI" | "HUMAN";
    text: string;
    startedMs?: number | null;
    endedMs?: number | null;
    confidence?: number | null;
    externalEventId?: string | null;
  },
) {
  const textValue = input.text.trim();
  if (!textValue) throw new Error("Voice transcript text cannot be empty.");

  return db.transaction(async (tx) => {
    if (input.externalEventId) {
      const [existing] = await tx.select().from(voiceTranscriptSegments).where(and(
        eq(voiceTranscriptSegments.workspaceId, workspaceId),
        eq(voiceTranscriptSegments.externalEventId, input.externalEventId),
      )).limit(1);
      if (existing) return existing;
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${callId}))`);
    const [call] = await tx.select({ id: voiceCalls.id }).from(voiceCalls).where(and(
      eq(voiceCalls.workspaceId, workspaceId),
      eq(voiceCalls.id, callId),
    )).limit(1);
    if (!call) throw new AppError("VOICE_CALL_NOT_FOUND", "Voice call not found.", 404);

    const [sequenceRow] = await tx.select({
      value: max(voiceTranscriptSegments.sequence),
    }).from(voiceTranscriptSegments).where(and(
      eq(voiceTranscriptSegments.workspaceId, workspaceId),
      eq(voiceTranscriptSegments.voiceCallId, callId),
    ));
    const sequence = (sequenceRow?.value ?? 0) + 1;
    const confidenceBps = input.confidence == null
      ? null
      : Math.max(0, Math.min(10_000, Math.round(input.confidence * 10_000)));

    const [created] = await tx.insert(voiceTranscriptSegments).values({
      workspaceId,
      voiceCallId: callId,
      speaker: input.speaker,
      text: textValue.slice(0, 100_000),
      startedMs: input.startedMs ?? null,
      endedMs: input.endedMs ?? null,
      sequence,
      confidenceBps,
      externalEventId: input.externalEventId ?? null,
    }).returning();
    return created;
  });
}
