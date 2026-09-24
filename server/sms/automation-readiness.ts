import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { capabilityBindings, hostedPhoneNumbers, integrations, smsRegistrations } from "@/db/schema";
import type { ApprovedSmsPolicy, SmsPurpose } from "./policy";

export type SmsAutomationReadiness = {
  status: "NOT_CONFIGURED" | "PROVIDER_DISCONNECTED" | "CARRIER_UNVERIFIED"
    | "REGISTRATION_REQUIRED" | "IN_REVIEW" | "REJECTED" | "PHONE_SUSPENDED" | "READY";
  categories: SmsPurpose[];
  message: string;
  setupUrl: string;
};

// This read-only status does not resolve runtime credentials or contact consent.
// Send-time validation in SMS outbound remains authoritative for every action.
export async function smsAutomationReadiness(workspaceId: string): Promise<SmsAutomationReadiness> {
  const base = { categories: [] as SmsPurpose[], setupUrl: "/settings?tab=phone#sms-registration" };
  const [binding] = await db.select({
    mode: capabilityBindings.mode,
    integrationId: capabilityBindings.integrationId,
  }).from(capabilityBindings).where(and(
    eq(capabilityBindings.workspaceId, workspaceId),
    eq(capabilityBindings.capability, "SMS"),
  )).limit(1);

  if (!binding) {
    return { ...base, status: "NOT_CONFIGURED", message: "Connect SMS before this automation can send messages." };
  }

  if (binding.mode === "BYOP") {
    const [integration] = binding.integrationId ? await db.select({
      status: integrations.status,
    }).from(integrations).where(and(
      eq(integrations.workspaceId, workspaceId),
      eq(integrations.id, binding.integrationId),
    )).limit(1) : [];
    if (integration?.status !== "CONNECTED") {
      return { ...base, status: "PROVIDER_DISCONNECTED",
        message: "Reconnect your SMS provider before this automation can send messages.",
        setupUrl: "/integrations" };
    }
    return { ...base, status: "CARRIER_UNVERIFIED",
      message: "SMS provider connected. Carrier registration and approved message categories cannot be verified in AI Caller for this connection.",
      setupUrl: "/integrations" };
  }

  const [number] = await db.select({
    id: hostedPhoneNumbers.id,
    status: hostedPhoneNumbers.status,
    messagingReadiness: hostedPhoneNumbers.messagingReadiness,
  }).from(hostedPhoneNumbers).where(and(
    eq(hostedPhoneNumbers.workspaceId, workspaceId),
    inArray(hostedPhoneNumbers.status, ["ACTIVE", "PAST_DUE", "SUSPENDED"]),
    isNull(hostedPhoneNumbers.releasedAt),
  )).limit(1);
  if (!number) {
    return { ...base, status: "NOT_CONFIGURED",
      message: "Activate an AI Caller number before this automation can send SMS." };
  }

  if (number.status === "SUSPENDED") {
    return { ...base, status: "PHONE_SUSPENDED",
      message: "The AI Caller phone number is suspended. SMS actions will not send until phone service is restored.",
      setupUrl: "/settings?tab=phone" };
  }

  const [registration] = await db.select({
    status: smsRegistrations.status,
    approvedPolicy: smsRegistrations.approvedPolicy,
  }).from(smsRegistrations).where(and(
    eq(smsRegistrations.workspaceId, workspaceId),
    eq(smsRegistrations.phoneNumberId, number.id),
  )).limit(1);

  if (number.messagingReadiness === "REJECTED" || registration?.status === "REJECTED") {
    return { ...base, status: "REJECTED",
      message: "SMS registration was rejected. Update your registration to enable automated messages." };
  }
  if (number.messagingReadiness === "READY" && registration?.status === "READY"
    && registration.approvedPolicy) {
    const categories = (registration.approvedPolicy as ApprovedSmsPolicy).categories;
    return { ...base, status: "READY", categories,
      message: `SMS ready for ${categories.map(category => category.toLowerCase()).join(" and ")} messages. Contact consent is still checked before each send.` };
  }
  if (number.messagingReadiness === "PENDING"
    || ["SUBMITTING", "PENDING"].includes(registration?.status ?? "")) {
    return { ...base, status: "IN_REVIEW",
      message: "SMS registration is under review. You can publish this automation; SMS actions will be skipped until approved." };
  }
  return { ...base, status: "REGISTRATION_REQUIRED",
    message: "SMS registration is not approved. You can configure the automation now; messages will not send until approval." };
}
