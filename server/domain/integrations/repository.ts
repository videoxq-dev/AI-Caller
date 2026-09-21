import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  calendarSetupSettings,
  capabilityBindings,
  communicationSetupSettings,
  hostedPhoneNumbers,
  integrations,
} from "@/db/schema";
import { getBusinessSetup, markSetupStep } from "@/server/domain/onboarding/repository";
import { AppError } from "@/server/http/errors";
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
  maskSecret,
  redactSecretsFromText,
  type EncryptedSecretEnvelope,
} from "@/server/security/secrets";
import { assertProviderSupportsCapability } from "@/server/providers/catalog";
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

function decryptCredentialMap(envelope: Record<string, unknown> | null | undefined) {
  if (!envelope) return {} as Record<string, string>;
  return decryptIntegrationCredentials<Record<string, string>>(envelope as EncryptedSecretEnvelope);
}

function maskedCredentialMap(envelope: Record<string, unknown> | null) {
  if (!envelope) return {};
  try {
    const credentials = decryptCredentialMap(envelope);
    return Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, maskSecret(value)]));
  } catch {
    return {};
  }
}

function providerErrorMessage(message: string, envelope: Record<string, unknown> | null) {
  try {
    return redactSecretsFromText(message, Object.values(decryptCredentialMap(envelope))).slice(0, 500);
  } catch {
    return message.slice(0, 500);
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

function assertIntegrationIdentity(input: IntegrationSaveInput) {
  const expectedCategory = categoryByProvider[input.provider];
  if (!expectedCategory) throw new Error(`Unsupported integration provider: ${input.provider}`);
  if (input.category !== expectedCategory) throw new Error(`${input.provider} must use the ${expectedCategory} integration category.`);

  const expectedMode = input.provider === "credits" ? "HOSTED" : "BYOP";
  if (input.mode !== expectedMode) throw new Error(`${input.provider} must use ${expectedMode} mode.`);
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
  assertIntegrationIdentity(input);
  const [existing] = await db.select().from(integrations).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, input.provider))).limit(1);
  const credentialsChanged = hasCredentials(input.credentials);
  const incomingCredentials = Object.fromEntries(Object.entries(input.credentials).filter(([, value]) => value.trim().length > 0));
  const existingCredentials = existing?.encryptedCredentials ? decryptCredentialMap(existing.encryptedCredentials) : {};
  const mergedCredentials = { ...existingCredentials, ...incomingCredentials };
  const encryptedCredentials = credentialsChanged
    ? (encryptIntegrationCredentials(mergedCredentials) as unknown as Record<string, unknown>)
    : existing?.encryptedCredentials ?? null;
  const previousSettings = existing?.settings && typeof existing.settings === "object" ? existing.settings as Record<string, unknown> : {};
  const settings = { ...previousSettings, ...input.settings };
  const now = new Date();
  const nextStatus = credentialsChanged ? "DISCONNECTED" as const : existing?.status ?? "DISCONNECTED" as const;

  const [row] = await db.insert(integrations).values({
    workspaceId,
    provider: input.provider,
    category: input.category,
    mode: input.mode,
    status: nextStatus,
    encryptedCredentials,
    settings,
    lastError: credentialsChanged ? null : existing?.lastError ?? null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [integrations.workspaceId, integrations.provider],
    set: {
      category: input.category,
      mode: input.mode,
      status: nextStatus,
      encryptedCredentials,
      settings,
      lastError: credentialsChanged ? null : existing?.lastError ?? null,
      updatedAt: now,
    },
  }).returning();

  return publicIntegration(row);
}

async function clearCalendarBindingForIntegration(workspaceId: string, integrationId: string) {
  await db.delete(capabilityBindings).where(and(
    eq(capabilityBindings.workspaceId, workspaceId),
    eq(capabilityBindings.capability, "CALENDAR"),
    eq(capabilityBindings.integrationId, integrationId),
  ));
}

export async function setIntegrationStatus(workspaceId: string, provider: string, status: "CONNECTED" | "ERROR" | "DISCONNECTED", lastError: string | null = null) {
  const [row] = await db.update(integrations).set({ status, lastError, updatedAt: new Date() }).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider))).returning();
  if (row && status === "DISCONNECTED") {
    await db.delete(capabilityBindings).where(and(
      eq(capabilityBindings.workspaceId, workspaceId),
      eq(capabilityBindings.integrationId, row.id),
    ));
  } else if (row?.category === "CALENDAR" && status === "ERROR") {
    // A failed calendar connection must not keep owning the CALENDAR
    // capability. Removing the route lets runtime use native scheduling.
    await clearCalendarBindingForIntegration(workspaceId, row.id);
  }
  return row ? publicIntegration(row) : null;
}

export async function testSavedIntegration(workspaceId: string, provider: string, fetcher: typeof fetch = fetch) {
  const row = await getPrivateIntegration(workspaceId, provider);
  if (!row) throw new Error("Integration not found.");
  const testedAt = new Date();
  try {
    const result = await testProviderConnection({ provider: row.provider, encryptedCredentials: row.encryptedCredentials, settings: row.settings }, fetcher);
    const settings = result.metadata ? { ...row.settings, connectionMetadata: result.metadata } : row.settings;
    const [updated] = await db.update(integrations).set({ status: "CONNECTED", lastTestedAt: testedAt, lastError: null, settings, updatedAt: testedAt }).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider))).returning();
    return { ok: true as const, integration: publicIntegration(updated) };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "Provider connection failed.";
    const message = providerErrorMessage(rawMessage, row.encryptedCredentials);
    const [updated] = await db.update(integrations).set({ status: "ERROR", lastTestedAt: testedAt, lastError: message, updatedAt: testedAt }).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider))).returning();
    if (updated?.category === "CALENDAR") {
      await clearCalendarBindingForIntegration(workspaceId, updated.id);
    }
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
  if (mode === "BYOP") {
    if (!provider) throw new Error(`${capability} requires a provider when using BYOP mode.`);
    if (provider === "credits") throw new Error("Our Credits is a hosted AI route and cannot be configured as BYOP.");
    assertProviderSupportsCapability(provider, capability);
  } else if (capability === "CALENDAR" || capability === "WHATSAPP") {
    throw new Error(`${capability} does not support hosted routing.`);
  }

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
  const [integration] = await db.select().from(integrations).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.id, binding.integrationId))).limit(1);
  return { ...binding, integration: integration ? publicIntegration(integration) : null };
}

export async function getCommunicationSetup(workspaceId: string) {
  const [row] = await db.select().from(communicationSetupSettings).where(eq(communicationSetupSettings.workspaceId, workspaceId)).limit(1);
  return row?.settings ?? null;
}

async function requireManagedPhoneReady(workspaceId: string) {
  const [number] = await db.select({ id: hostedPhoneNumbers.id })
    .from(hostedPhoneNumbers)
    .where(and(
      eq(hostedPhoneNumbers.workspaceId, workspaceId),
      eq(hostedPhoneNumbers.status, "ACTIVE"),
      isNull(hostedPhoneNumbers.releasedAt),
    ))
    .limit(1);
  if (!number) {
    throw new Error("Choose and activate an AI Caller phone number before completing communication setup.");
  }
}

export async function saveCommunicationSetup(workspaceId: string, input: CommunicationSetupInput) {
  if (input.completeStep && (input.voice.mode === "HOSTED" || input.sms.mode === "HOSTED")) {
    await requireManagedPhoneReady(workspaceId);
  }
  const settings = { voice: input.voice, sms: input.sms, whatsapp: input.whatsapp, webchat: input.webchat };
  const now = new Date();
  await db.insert(communicationSetupSettings).values({ workspaceId, settings, updatedAt: now }).onConflictDoUpdate({ target: communicationSetupSettings.workspaceId, set: { settings, updatedAt: now } });
  const capabilityWrites = [
    bindCapability(workspaceId, "VOICE", input.voice.mode, input.voice.provider),
    bindCapability(workspaceId, "SMS", input.sms.mode, input.sms.provider),
    bindCapability(workspaceId, "WHATSAPP", input.whatsapp.mode, input.whatsapp.provider ?? "whatsapp"),
  ];
  await Promise.all(capabilityWrites);
  if (input.completeStep) await markSetupStep(workspaceId, "communication", now);
  return settings;
}

export async function getCalendarSetup(workspaceId: string) {
  const [row] = await db.select().from(calendarSetupSettings).where(eq(calendarSetupSettings.workspaceId, workspaceId)).limit(1);
  return row?.settings ?? null;
}

export async function saveCalendarSetup(workspaceId: string, input: CalendarSetupInput) {
  const connected = await getPrivateIntegration(workspaceId, input.provider);
  if (input.completeStep && connected?.status !== "CONNECTED") {
    const business = await getBusinessSetup(workspaceId);
    if (!business.profile || !business.hours.some(day => day.enabled)) {
      throw new AppError("BUSINESS_HOURS_NOT_CONFIGURED",
        "Configure your business hours to use the built-in calendar without an external integration.", 409);
    }
  }
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
  if (connected?.status === "CONNECTED") {
    await bindCapability(workspaceId, "CALENDAR", "BYOP", input.provider);
  } else {
    // Native scheduling is authoritative when no selected provider is connected.
    // Remove any stale BYOP calendar route so runtime resolution cannot point at
    // a disconnected provider and block the in-app fallback.
    await db.delete(capabilityBindings).where(and(
      eq(capabilityBindings.workspaceId, workspaceId),
      eq(capabilityBindings.capability, "CALENDAR"),
    ));
  }
  if (input.completeStep) await markSetupStep(workspaceId, "calendar", now);
  return settings;
}
