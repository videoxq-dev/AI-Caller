import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { getCalendarSetup, getPrivateIntegration } from "@/server/domain/integrations/repository";
import type { AIProvider, CalendarProvider } from "./contracts";
import { createAIProvider, createHostedAIProvider } from "./ai";
import { createCalendarProvider } from "./calendar";
import { assertProviderSupportsCapability } from "./catalog";
import { createE2EAIProvider, createE2ECalendarProvider, isE2EProviderFixtureMode } from "./e2e-fixtures";
import { resolveProviderRoute } from "./resolver";

export async function resolveAIProvider(workspaceId: string, fetcher: typeof fetch = fetch): Promise<AIProvider> {
  if (isE2EProviderFixtureMode()) return createE2EAIProvider();
  const route = await resolveProviderRoute(workspaceId, "AI_TEXT");
  if (!route) return createHostedAIProvider(fetcher);
  if (route.mode === "HOSTED") return createHostedAIProvider(fetcher);

  assertProviderSupportsCapability(route.provider, "AI_TEXT");
  const integration = await getPrivateIntegration(workspaceId, route.provider);
  if (!integration) throw new Error(`The ${route.provider} integration no longer exists.`);
  if (integration.status !== "CONNECTED") throw new Error(`The ${route.provider} AI integration is not connected.`);
  return createAIProvider(integration, fetcher);
}

export async function resolveCalendarProvider(workspaceId: string, fetcher: typeof fetch = fetch): Promise<CalendarProvider> {
  const route = await resolveProviderRoute(workspaceId, "CALENDAR");
  if (!route) throw new Error("No calendar provider is configured for this workspace.");
  if (route.mode !== "BYOP") throw new Error("Hosted calendar routing is not supported.");

  assertProviderSupportsCapability(route.provider, "CALENDAR");
  const integration = await getPrivateIntegration(workspaceId, route.provider);
  if (!integration) throw new Error(`The ${route.provider} calendar integration no longer exists.`);
  if (integration.status !== "CONNECTED") throw new Error(`The ${route.provider} calendar integration is not connected.`);
  if (isE2EProviderFixtureMode()) return createE2ECalendarProvider();
  const setup = await getCalendarSetup(workspaceId);
  return createCalendarProvider({ ...integration, runtimeSettings: setup ?? {} }, fetcher);
}

export async function resolveCalendarProviderForIntegration(
  workspaceId: string,
  integrationId: string,
  fetcher: typeof fetch = fetch,
): Promise<CalendarProvider> {
  const [integration] = await db.select().from(integrations).where(and(
    eq(integrations.workspaceId, workspaceId),
    eq(integrations.id, integrationId),
  )).limit(1);

  if (!integration) throw new Error("The appointment's calendar integration no longer exists.");
  assertProviderSupportsCapability(integration.provider, "CALENDAR");
  if (integration.status !== "CONNECTED") throw new Error(`The ${integration.provider} calendar integration is not connected.`);
  if (isE2EProviderFixtureMode()) return createE2ECalendarProvider();
  const setup = await getCalendarSetup(workspaceId);
  return createCalendarProvider({ ...integration, runtimeSettings: setup ?? {} }, fetcher);
}
