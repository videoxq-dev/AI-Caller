import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  calendarSetupSettings,
  capabilityBindings,
  communicationSetupSettings,
  integrations,
} from "@/db/schema";
import { markSetupStep } from "@/server/domain/onboarding/repository";
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
  maskSecret,
  type EncryptedSecretEnvelope,
} from "@/server/security/secrets";
import { testProviderConnection } from "@/server/providers/connections";
import type { CalendarSetupInput, CommunicationSetupInput, IntegrationSaveInput } from "./schemas";

const categoryByProvider: Record<string, "AI" | "COMMUNICATION" | "WHATSAPP" | "CALENDAR"> = {
  plivo: "COMMUNICATION",
  telnyx: "COMMUNICATION",
  twilio: "COMMUNICATION",
  whatsapp: "WHATSAPP",
  credits: "AI",
  openai: "AI",
  gemini: "AI",
  openrouter: "AI",
  google: "CALENDAR",
  outlook: "CALENDAR",
  calendly: "CALENDAR",
  calcom: "CALENDAR",
};

function hasCredentials(credentials: Record<string, string>) {
  return Object.values(credentials).some((value) => value.trim().length > 0);
}

function maskedCredentialMap(envelope: Record<string, unknown> | null) {
  if (!envelope) return {};
  try {
    const credentials = decryptIntegrationCredentials<Record<string, string>>(envelope as EncryptedSecretEnvelope);
    return Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, maskSecret(value)]));
  } catch {
    return {};
  }
}

function publicIntegration(row: typeof integrations.$inferSelect) {
  return {
    id: row.id,
    provider: row.provider,
    category: row.category,
    mode: row.mode,
    status: row.status,
    settings: row.settings,
    maskedCredentials: maskedCredentialMap(row.encryptedCredentials),
    lastTestedAt: row.lastTestedAt,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

export async function listIntegrations(workspaceId: string) {
  const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, workspaceId));
  return rows.map(publicIntegration);
}

export async function getIntegration(workspaceId: string, provider: string) {
  const [row] = await db.select().from(integrations).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider))).limit(1);
  return row ? publicIntegration(row) : null;
}

export async function getPrivateIntegration(workspaceId: string, provider: string) {
  const [row] = await db.select().from(integrations).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider))).limit(1);
  return row ?? null;
}

export async function saveIntegration(workspaceId: string, input: IntegrationSaveInput) {
  const [existing] = await db.select().from(integrations).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, input.provider))).limit(1);
  const credentialsChanged = hasCredentials(input.credentials);
  const encryptedCredentials = credentialsChanged
    ? (encryptIntegrationCredentials(input.credentials) as unknown as Record<string, unknown>)
    : existing?.encryptedCredentials ?? null;
  const now = new Date();
  const nextStatus = credentialsChanged ? "DISCONNECTED" as const : existing?.status ?? "DISCONNECTED" as const;

  const [row] = await db.insert(integrations).values({
    workspaceId,
    provider: input.provider,
    category: input.category,
    mode: input.mode,
    status: nextStatus,
    encryptedCredentials,
    settings: input.settings,
    lastError: credentialsChanged ? null : existing?.lastError ?? null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [integrations.workspaceId, integrations.provider],
    set: {
      category: input.category,
      mode: input.mode,
      status: nextStatus,
      encryptedCredentials,
      settings: input.settings,
      lastError: credentialsChanged ? null : existing?.lastError ?? null,
      updatedAt: now,
    },
  }).returning();

  return publicIntegration(row);
}

export async function setIntegrationStatus(workspaceId: string, provider: string, status: "CONNECTED" | "ERROR" | "DISCONNECTED", lastError: string | null = null) {
  const [row] = await db.update(integrations).set({ status, lastError, updatedAt: new Date() }).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider))).returning();
  return row ? publicIntegration(row) : null;
}

export async function testSavedIntegration(workspaceId: string, provider: string) {
  const row = await getPrivateIntegration(workspaceId, provider);
  if (!row) throw new Error("Integration not found.");
  const testedAt = new Date();
  try {
    const result = await testProviderConnection({ provider: row.provider, encryptedCredentials: row.encryptedCredentials, settings: row.settings });
    const settings = result.metadata ? { ...row.settings, connectionMetadata: result.metadata } : row.settings;
    const [updated] = await db.update(integrations).set({ status: "CONNECTED", lastTestedAt: testedAt, lastError: null, settings, updatedAt: testedAt }).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider))).returning();
    return { ok: true as const, integration: publicIntegration(updated) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider connection failed.";
    const [updated] = await db.update(integrations).set({ status: "ERROR", lastTestedAt: testedAt, lastError: message.slice(0, 500), updatedAt: testedAt }).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider))).returning();
    return { ok: false as const, error: message, integration: publicIntegration(updated) };
  }
}

export async function saveVerifiedIntegration(workspaceId: string, input: IntegrationSaveInput, metadata: Record<string, unknown> = {}) {
  const integration = await saveIntegration(workspaceId, input);
  const [row] = await db.update(integrations).set({ status: "CONNECTED", lastTestedAt: new Date(), lastError: null, settings: { ...integration.settings, ...metadata }, updatedAt: new Date() }).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, input.provider))).returning();
  return publicIntegration(row);
}

async function ensureIntegration(workspaceId: string, provider: string) {
  const [existing] = await db.select().from(integrations).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider))).limit(1);
  if (existing) return existing;
  const category = categoryByProvider[provider];
  if (!category) throw new Error(`Unsupported integration provider: ${provider}`);
  const [row] = await db.insert(integrations).values({ workspaceId, provider, category, mode: "BYOP", status: "DISCONNECTED" }).returning();
  return row;
}

async function requireConnectedProvider(workspaceId: string, provider: string, label: string) {
  const [row] = await db.select({ status: integrations.status }).from(integrations).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider))).limit(1);
  if (row?.status !== "CONNECTED") throw new Error(`${label} provider ${provider} must be connected before this setup step can be completed.`);
}

export async function bindCapability(workspaceId: string, capability: "AI_TEXT" | "SMS" | "VOICE" | "WHATSAPP" | "CALENDAR", mode: "HOSTED" | "BYOP", provider?: string | null) {
  const integration = mode === "BYOP" && provider ? await ensureIntegration(workspaceId, provider) : null;
  const now = new Date();
  const [binding] = await db.insert(capabilityBindings).values({ workspaceId, capability, mode, integrationId: integration?.id ?? null, updatedAt: now }).onConflictDoUpdate({
    target: [capabilityBindings.workspaceId, capabilityBindings.capability],
    set: { mode, integrationId: integration?.id ?? null, updatedAt: now },
  }).returning();
  return binding;
}

export async function resolveCapability(workspaceId: string, capability: "AI_TEXT" | "SMS" | "VOICE" | "WHATSAPP" | "CALENDAR") {
  const [binding] = await db.select().from(capabilityBindings).where(and(eq(capabilityBindings.workspaceId, workspaceId), eq(capabilityBindings.capability, capability))).limit(1);
  if (!binding) return null;
  if (!binding.integrationId) return { ...binding, integration: null };
  const [integration] = await db.select().from(integrations).where(eq(integrations.id, binding.integrationId)).limit(1);
  return { ...binding, integration: integration ? publicIntegration(integration) : null };
}

export async function getCommunicationSetup(workspaceId: string) {
  const [row] = await db.select().from(communicationSetupSettings).where(eq(communicationSetupSettings.workspaceId, workspaceId)).limit(1);
  return row?.settings ?? null;
}

export async function saveCommunicationSetup(workspaceId: string, input: CommunicationSetupInput) {
  if (input.completeStep) {
    if (input.voice.mode === "BYOP" && input.voice.provider) await requireConnectedProvider(workspaceId, input.voice.provider, "Voice");
    if (input.sms.mode === "BYOP" && input.sms.provider) await requireConnectedProvider(workspaceId, input.sms.provider, "SMS");
    if (input.whatsapp.mode === "BYOP") await requireConnectedProvider(workspaceId, input.whatsapp.provider ?? "whatsapp", "WhatsApp");
  }
  const settings = { voice: input.voice, sms: input.sms, whatsapp: input.whatsapp, webchat: input.webchat };
  const now = new Date();
  await db.insert(communicationSetupSettings).values({ workspaceId, settings, updatedAt: now }).onConflictDoUpdate({ target: communicationSetupSettings.workspaceId, set: { settings, updatedAt: now } });
  await Promise.all([
    bindCapability(workspaceId, "VOICE", input.voice.mode, input.voice.provider),
    bindCapability(workspaceId, "SMS", input.sms.mode, input.sms.provider),
    bindCapability(workspaceId, "WHATSAPP", input.whatsapp.mode, input.whatsapp.provider ?? "whatsapp"),
  ]);
  if (input.completeStep) await markSetupStep(workspaceId, "communication", now);
  return settings;
}

export async function getCalendarSetup(workspaceId: string) {
  const [row] = await db.select().from(calendarSetupSettings).where(eq(calendarSetupSettings.workspaceId, workspaceId)).limit(1);
  return row?.settings ?? null;
}

export async function saveCalendarSetup(workspaceId: string, input: CalendarSetupInput) {
  if (input.completeStep) await requireConnectedProvider(workspaceId, input.provider, "Calendar");
  const settings = {
    provider: input.provider,
    meetingDurationMinutes: input.meetingDurationMinutes,
    bufferBeforeMinutes: input.bufferBeforeMinutes,
    bufferAfterMinutes: input.bufferAfterMinutes,
    availableDays: input.availableDays,
    startTime: input.startTime,
    endTime: input.endTime,
    timezone: input.timezone,
    suggestAlternatives: input.suggestAlternatives,
    eventType: input.eventType ?? null,
    meetingLocation: input.meetingLocation ?? null,
    maxBookingsPerDay: input.maxBookingsPerDay,
  };
  const now = new Date();
  await db.insert(calendarSetupSettings).values({ workspaceId, settings, updatedAt: now }).onConflictDoUpdate({ target: calendarSetupSettings.workspaceId, set: { settings, updatedAt: now } });
  await bindCapability(workspaceId, "CALENDAR", "BYOP", input.provider);
  if (input.completeStep) await markSetupStep(workspaceId, "calendar", now);
  return settings;
}
