import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { licenses, memberships } from "@/db/schema";
import { AppError } from "@/server/http/errors";

export const CALENDAR_PROVIDERS = new Set(["google", "outlook", "calendly", "calcom"]);

export type WorkspaceIntegrationEntitlements = {
  purchaserUserId: string | null;
  unlimited: boolean;
  externalCalendar: boolean;
  agencyByop: boolean;
};

export async function getWorkspaceIntegrationEntitlements(
  workspaceId: string,
): Promise<WorkspaceIntegrationEntitlements> {
  const owners = await db.select({ userId: memberships.userId }).from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "OWNER")))
    .limit(2);
  if (owners.length !== 1) {
    return { purchaserUserId: null, unlimited: false, externalCalendar: false, agencyByop: false };
  }

  const rows = await db.select({ productCode: licenses.productCode }).from(licenses).where(and(
    eq(licenses.purchaserUserId, owners[0].userId),
    eq(licenses.status, "ACTIVE"),
  ));
  const products = new Set(rows.map((row) => row.productCode));
  const unlimited = products.has("UNLIMITED");
  return {
    purchaserUserId: owners[0].userId,
    unlimited,
    externalCalendar: unlimited,
    agencyByop: products.has("AGENCY_50") || products.has("AGENCY_100"),
  };
}

export function isExternalCalendarProvider(provider: string) {
  return CALENDAR_PROVIDERS.has(provider);
}

export async function requireProviderIntegrationEntitlement(workspaceId: string, provider: string) {
  if (provider === "credits" || provider === "whatsapp") return;

  const entitlement = await getWorkspaceIntegrationEntitlements(workspaceId);
  if (isExternalCalendarProvider(provider)) {
    if (!entitlement.externalCalendar) {
      throw new AppError(
        "EXTERNAL_CALENDAR_REQUIRES_UNLIMITED",
        "Upgrade to Unlimited to connect an external calendar.",
        403,
      );
    }
    return;
  }

  if (!entitlement.agencyByop) {
    throw new AppError(
      "BYOP_REQUIRES_AGENCY",
      "Bring-your-own-provider integrations are available on Agency.",
      403,
    );
  }
}

export async function requireCapabilityBindingEntitlement(
  workspaceId: string,
  capability: "AI_TEXT" | "SMS" | "VOICE" | "WHATSAPP" | "CALENDAR",
  mode: "HOSTED" | "BYOP",
  provider?: string | null,
) {
  if (mode !== "BYOP") return;
  if (capability === "WHATSAPP" && provider === "whatsapp") return;
  if (capability === "CALENDAR") {
    const entitlement = await getWorkspaceIntegrationEntitlements(workspaceId);
    if (!entitlement.externalCalendar) {
      throw new AppError(
        "EXTERNAL_CALENDAR_REQUIRES_UNLIMITED",
        "Upgrade to Unlimited to connect an external calendar.",
        403,
      );
    }
    return;
  }
  const entitlement = await getWorkspaceIntegrationEntitlements(workspaceId);
  if (!entitlement.agencyByop) {
    throw new AppError(
      "BYOP_REQUIRES_AGENCY",
      "Bring-your-own-provider integrations are available on Agency.",
      403,
    );
  }
}
