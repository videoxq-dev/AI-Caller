import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { capabilityBindings, integrations } from "@/db/schema";
import { assertProviderSupportsCapability } from "./catalog";
import type { Capability, ProviderRoute } from "./contracts";

export async function resolveProviderRoute(workspaceId: string, capability: Capability): Promise<ProviderRoute | null> {
  const [binding] = await db.select().from(capabilityBindings).where(and(eq(capabilityBindings.workspaceId, workspaceId), eq(capabilityBindings.capability, capability))).limit(1);

  if (!binding) {
    if (capability === "AI_TEXT") {
      return { workspaceId, capability, mode: "HOSTED", provider: "credits", integrationId: null, settings: {} };
    }
    return null;
  }

  if (binding.mode === "HOSTED") {
    return { workspaceId, capability, mode: "HOSTED", provider: capability === "AI_TEXT" ? "credits" : "hosted", integrationId: null, settings: {} };
  }

  if (!binding.integrationId) throw new Error(`No integration is bound to ${capability}.`);
  const [integration] = await db.select().from(integrations).where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.id, binding.integrationId))).limit(1);
  if (!integration) {
    // Calendar has an authoritative native fallback. A stale BYOP binding must
    // not make availability/booking fail just because the external integration
    // disappeared after setup.
    if (capability === "CALENDAR") return null;
    throw new Error(`The integration bound to ${capability} no longer exists.`);
  }
  assertProviderSupportsCapability(integration.provider, capability);
  if (integration.status !== "CONNECTED") {
    // Treat an unusable external calendar route as absent so the calendar
    // domain can fall back to the built-in scheduler. Other capabilities keep
    // their existing fail-closed behavior.
    if (capability === "CALENDAR") return null;
    throw new Error(`The ${integration.provider} integration for ${capability} is not connected.`);
  }

  return {
    workspaceId,
    capability,
    mode: "BYOP",
    provider: integration.provider,
    integrationId: integration.id,
    settings: integration.settings,
  };
}
