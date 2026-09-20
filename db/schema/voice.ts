import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contacts, conversations } from "./core-domain";
import { integrations } from "./integrations";
import { workspaces } from "./core";

export const voiceCallMode = pgEnum("voice_call_mode", ["AI_FIRST", "AFTER_HOURS", "OVERFLOW"]);
export const voiceCallStatus = pgEnum("voice_call_status", ["RINGING", "ACTIVE", "COMPLETED", "FAILED"]);
export const voiceRecordingStatus = pgEnum("voice_recording_status", ["PENDING", "RECORDING", "AVAILABLE", "FAILED", "DECLINED"]);
export const voiceRecordingConsentStatus = pgEnum("voice_recording_consent_status", ["PENDING", "NOT_REQUIRED", "ANNOUNCED", "GRANTED", "DECLINED"]);
export const voiceTranscriptStatus = pgEnum("voice_transcript_status", ["PENDING", "ACTIVE", "COMPLETE", "FAILED"]);
export const voiceTranscriptSpeaker = pgEnum("voice_transcript_speaker", ["CUSTOMER", "AI", "HUMAN"]);

export const voiceCalls = pgTable(
  "voice_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id").references(() => integrations.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    externalCallId: text("external_call_id").notNull(),
    callControlId: text("call_control_id"),
    fromNumber: text("from_number").notNull(),
    toNumber: text("to_number").notNull(),
    mode: voiceCallMode("mode").default("AI_FIRST").notNull(),
    status: voiceCallStatus("status").default("RINGING").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true, mode: "date" }),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    durationSeconds: integer("duration_seconds"),
    recordingStatus: voiceRecordingStatus("recording_status").default("PENDING").notNull(),
    recordingExternalId: text("recording_external_id"),
    recordingObjectKey: text("recording_object_key"),
    recordingMimeType: text("recording_mime_type"),
    recordingDurationSeconds: integer("recording_duration_seconds"),
    recordingConsentStatus: voiceRecordingConsentStatus("recording_consent_status").default("PENDING").notNull(),
    recordingDisclosureVersion: text("recording_disclosure_version"),
    recordingDisclosedAt: timestamp("recording_disclosed_at", { withTimezone: true, mode: "date" }),
    transcriptStatus: voiceTranscriptStatus("transcript_status").default("PENDING").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("voice_calls_workspace_provider_external_uq").on(table.workspaceId, table.provider, table.externalCallId),
    index("voice_calls_workspace_started_idx").on(table.workspaceId, table.startedAt),
    index("voice_calls_conversation_started_idx").on(table.conversationId, table.startedAt),
  ],
);

export const voiceTranscriptSegments = pgTable(
  "voice_transcript_segments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    voiceCallId: uuid("voice_call_id").notNull().references(() => voiceCalls.id, { onDelete: "cascade" }),
    speaker: voiceTranscriptSpeaker("speaker").notNull(),
    text: text("text").notNull(),
    startedMs: integer("started_ms"),
    endedMs: integer("ended_ms"),
    sequence: integer("sequence").notNull(),
    confidenceBps: integer("confidence_bps"),
    externalEventId: text("external_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("voice_transcript_call_sequence_uq").on(table.voiceCallId, table.sequence),
    uniqueIndex("voice_transcript_workspace_external_event_uq")
      .on(table.workspaceId, table.externalEventId)
      .where(sql`${table.externalEventId} IS NOT NULL`),
    index("voice_transcript_call_created_idx").on(table.voiceCallId, table.createdAt),
  ],
);

export const workspaceVoiceTechnology = pgTable("workspace_voice_technology", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  technology: text("technology").$type<"STANDARD" | "REALTIME">().default("STANDARD").notNull(),
  realtimeModel: text("realtime_model").$type<"gpt-realtime-2.1" | "gpt-realtime-2.1-mini">().default("gpt-realtime-2.1").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const voiceRealtimeResponseUsage = pgTable("voice_realtime_response_usage", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  voiceCallId: uuid("voice_call_id").notNull().references(() => voiceCalls.id, { onDelete: "cascade" }),
  responseId: text("response_id").notNull(),
  usage: jsonb("usage").$type<Record<string, number>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("voice_realtime_response_usage_voice_call_id_response_id_key").on(table.voiceCallId, table.responseId),
  index("voice_realtime_response_usage_workspace_call_idx").on(table.workspaceId, table.voiceCallId),
]);
