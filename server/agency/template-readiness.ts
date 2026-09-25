import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  agencyWorkspaceTemplateApplications, aiAgents, businessHours, businessProfiles,
  calendarSetupSettings, communicationSetupSettings, creditWallets,
  hostedPhoneNumbers, setupProgress,
} from "@/db/schema";
import { capabilitiesFromBehaviorSettings } from "@/server/agent/capabilities";
import { smsAutomationReadiness } from "@/server/sms/automation-readiness";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AgencyCloneReadinessItem = {
  key: "business" | "agent" | "communication" | "phone" | "calendar" | "sms" | "credits";
  ready: boolean;
  message: string;
  href: string;
};

export type AgencyCloneReadiness = {
  templatedClient: true;
  canActivate: boolean;
  items: AgencyCloneReadinessItem[];
};

export async function getAgencyCloneReadiness(
  workspaceId: string,
  tx: Tx | typeof db = db,
): Promise<AgencyCloneReadiness | null> {
  const [application] = await tx.select({ id: agencyWorkspaceTemplateApplications.id })
    .from(agencyWorkspaceTemplateApplications)
    .where(eq(agencyWorkspaceTemplateApplications.workspaceId, workspaceId)).limit(1);
  if (!application) return null;

  const [profile, progress, agent, communication, calendar, wallet, numbers, hours] = await Promise.all([
    tx.select().from(businessProfiles).where(eq(businessProfiles.workspaceId, workspaceId)).limit(1),
    tx.select().from(setupProgress).where(eq(setupProgress.workspaceId, workspaceId)).limit(1),
    tx.select().from(aiAgents).where(eq(aiAgents.workspaceId, workspaceId)).limit(1),
    tx.select().from(communicationSetupSettings)
      .where(eq(communicationSetupSettings.workspaceId, workspaceId)).limit(1),
    tx.select().from(calendarSetupSettings).where(eq(calendarSetupSettings.workspaceId, workspaceId)).limit(1),
    tx.select({ balance: creditWallets.balance }).from(creditWallets)
      .where(eq(creditWallets.workspaceId, workspaceId)).limit(1),
    tx.select({ id: hostedPhoneNumbers.id }).from(hostedPhoneNumbers).where(and(
      eq(hostedPhoneNumbers.workspaceId, workspaceId),
      eq(hostedPhoneNumbers.status, "ACTIVE"),
      isNull(hostedPhoneNumbers.releasedAt),
    )).limit(1),
    tx.select({ enabled: businessHours.enabled }).from(businessHours)
      .where(eq(businessHours.workspaceId, workspaceId)),
  ]);
  const capabilities = agent[0]
    ? capabilitiesFromBehaviorSettings(agent[0].behaviorSettings)
    : null;
  const bookingEnabled = Boolean(capabilities && (
    capabilities.CHECK_AVAILABILITY || capabilities.BOOK_APPOINTMENT
    || capabilities.RESCHEDULE_APPOINTMENT || capabilities.CANCEL_APPOINTMENT
  ));
  const smsEnabled = Boolean(capabilities?.SEND_SMS);
  const communicationSettings = communication[0]?.settings;
  const voice = communicationSettings?.voice;
  const hostedVoice = voice && typeof voice === "object" && "mode" in voice && voice.mode === "HOSTED";
  const sms = communicationSettings?.sms;
  const hostedSms = sms && typeof sms === "object" && "mode" in sms && sms.mode === "HOSTED";
  const needsHostedNumber = Boolean(hostedVoice || hostedSms);
  const items: AgencyCloneReadinessItem[] = [
    {
      key: "business",
      ready: Boolean(profile[0]?.setupCompletedAt && progress[0]?.businessCompletedAt),
      message: "Review and complete this client's own business details and hours.",
      href: "/setup/business",
    },
    {
      key: "agent",
      ready: Boolean(agent[0] && progress[0]?.aiCompletedAt),
      message: "Review the cloned agent's instructions, services, qualification and escalation.",
      href: "/setup/ai",
    },
    {
      key: "communication",
      ready: Boolean(communication[0] && progress[0]?.communicationCompletedAt),
      message: "Complete the client's own communication setup; source connections are never copied.",
      href: "/setup/communication",
    },
    {
      key: "phone",
      ready: !needsHostedNumber || numbers.length > 0,
      message: "Activate this workspace's own managed number for hosted voice or SMS.",
      href: "/setup/communication",
    },
    {
      key: "calendar",
      ready: !bookingEnabled || Boolean(calendar[0] && progress[0]?.calendarCompletedAt
        && hours.some((hour) => hour.enabled)),
      message: "Complete this client's calendar and business hours before enabling appointment actions.",
      href: "/setup/calendar",
    },
    {
      key: "credits",
      ready: (wallet[0]?.balance ?? 0) > 0,
      message: "Allocate hosted credits to this client from the Agency pool.",
      href: "/workspaces",
    },
  ];

  if (smsEnabled) {
    const readiness = await smsAutomationReadiness(workspaceId, tx);
    items.push({
      key: "sms",
      ready: readiness.status === "READY",
      message: readiness.status === "READY"
        ? "This workspace's SMS registration is ready; consent remains checked at send time."
        : readiness.message,
      href: readiness.setupUrl,
    });
  }

  return {
    templatedClient: true,
    canActivate: items.every((item) => item.ready),
    items,
  };
}
