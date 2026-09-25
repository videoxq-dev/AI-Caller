import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { licenses, memberships, workspaceCommercialOwners } from "@/db/schema";
import { getCommercialWorkspaceOwner } from "@/server/auth/commercial-ownership";
import { AppError } from "@/server/http/errors";

export const CALENDAR_PROVIDERS = new Set(["google", "outlook", "calendly", "calcom"]);

export type WorkspaceIntegrationEntitlements = {
  purchaserUserId: string | null;
  externalCalendar: boolean;
  performanceAutomations: boolean;
  /** Active Core + Agency + Whitelabel anchored to the commercial purchaser's original business. */
  whitelabelEligible: boolean;
  /** Deliberately disabled until F12-G defines one exclusive, purchaser-wide provider mode. */
  nonCalendarByopEnabled: boolean;
};

function denied(purchaserUserId: string | null = null): WorkspaceIntegrationEntitlements {
  return {
    purchaserUserId, externalCalendar: false, performanceAutomations: false,
    whitelabelEligible: false, nonCalendarByopEnabled: false,
  };
}

export async function getWorkspaceIntegrationEntitlements(
  workspaceId: string,
): Promise<WorkspaceIntegrationEntitlements> {
  const commercial = await getCommercialWorkspaceOwner(workspaceId);
  let purchaserUserId: string;
  let primaryId: string;
  let kind: "PRIMARY" | "ADDITIONAL";

  if (commercial) {
    purchaserUserId = commercial.purchaserUserId;
    kind = commercial.kind;
    if (kind === "PRIMARY") {
      primaryId = workspaceId;
    } else {
      const primaries = await db.select({ workspaceId: workspaceCommercialOwners.workspaceId })
        .from(workspaceCommercialOwners).where(and(
          eq(workspaceCommercialOwners.purchaserUserId, purchaserUserId),
          eq(workspaceCommercialOwners.kind, "PRIMARY"),
        )).limit(2);
      if (primaries.length !== 1) return denied(purchaserUserId);
      primaryId = primaries[0].workspaceId;
    }
  } else {
    // Historical workspaces with no commercial-owner record retain the sole
    // operational OWNER fallback. Multiple OWNERs are never guessed.
    const owners = await db.select({ userId: memberships.userId }).from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "OWNER")))
      .limit(2);
    if (owners.length !== 1) return denied();
    purchaserUserId = owners[0].userId;
    kind = "PRIMARY";
    primaryId = workspaceId;
  }

  const rows = await db.select({ code: licenses.productCode, workspaceId: licenses.workspaceId })
    .from(licenses).where(and(
      eq(licenses.purchaserUserId, purchaserUserId),
      eq(licenses.status, "ACTIVE"),
    ));
  const ownLicenses = new Set(rows.filter((row) => row.workspaceId === primaryId).map((row) => row.code));
  const agency = ownLicenses.has("AGENCY_50") || ownLicenses.has("AGENCY_100");
  const eligibleWhitelabel = Boolean(commercial) && ownLicenses.has("CORE")
    && agency && ownLicenses.has("WHITELABEL");

  // Client classification survives Agency refunds. Unlimited second businesses
  // created before an Agency purchase retain their separate offer features.
  const agencyClient = kind === "ADDITIONAL" && commercial !== null
    && commercial.agencyClient;
  const ownFeatureWorkspace = !agencyClient;
  return {
    purchaserUserId,
    externalCalendar: ownFeatureWorkspace && ownLicenses.has("UNLIMITED"),
    performanceAutomations: ownFeatureWorkspace && ownLicenses.has("PERFORMANCE"),
    whitelabelEligible: eligibleWhitelabel,
    nonCalendarByopEnabled: false,
  };
}

export function isExternalCalendarProvider(provider: string) {
  return CALENDAR_PROVIDERS.has(provider);
}

export async function requirePerformanceAutomationEntitlement(workspaceId: string) {
  const entitlement = await getWorkspaceIntegrationEntitlements(workspaceId);
  if (!entitlement.performanceAutomations) {
    throw new AppError(
      "AUTOMATION_BUILDER_REQUIRES_PERFORMANCE",
      "Automation Builder and custom automations require the Performance upgrade.",
      403,
    );
  }
}

async function requireNonCalendarByop(workspaceId: string) {
  const entitlement = await getWorkspaceIntegrationEntitlements(workspaceId);
  if (!entitlement.whitelabelEligible) {
    throw new AppError("BYOP_REQUIRES_WHITELABEL", "Bring-your-own-provider infrastructure requires Agency and Whitelabel.", 403);
  }
  if (!entitlement.nonCalendarByopEnabled) {
    throw new AppError("BYOP_MODE_NOT_CONFIGURED", "Activate a verified Whitelabel provider infrastructure mode before connecting BYOP.", 403);
  }
}

export async function requireProviderIntegrationEntitlement(workspaceId: string, provider: string) {
  if (provider === "credits" || provider === "whatsapp") return;

  if (isExternalCalendarProvider(provider)) {
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
  await requireNonCalendarByop(workspaceId);
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
  await requireNonCalendarByop(workspaceId);
}
