import type { TelnyxNumberOrder, TelnyxNumberOrderPhoneNumber } from "@/server/providers/telnyx-platform";

export type MessagingReadiness = "NOT_REGISTERED" | "PENDING" | "READY" | "REJECTED";

export type CarrierProvisioningOutcome =
  | { kind: "READY"; orderStatus: string; numberStatus: string }
  | { kind: "FAILED"; orderStatus: string | null; numberStatus: string | null }
  | { kind: "REQUIREMENTS"; orderStatus: string | null; numberStatus: string | null }
  | { kind: "PENDING"; orderStatus: string | null; numberStatus: string | null };

function normalized(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}

const FINAL_SUCCESS = new Set(["success", "completed"]);
const FINAL_FAILURE = new Set(["failure", "failed", "cancelled", "canceled"]);

export function carrierProvisioningOutcome(
  order: TelnyxNumberOrder | null,
  orderedNumber: TelnyxNumberOrderPhoneNumber | null,
): CarrierProvisioningOutcome {
  const orderStatus = normalized(order?.status);
  const numberStatus = normalized(orderedNumber?.status);
  const requirementsMet = order?.requirements_met !== false && orderedNumber?.requirements_met !== false;

  if ((orderStatus && FINAL_FAILURE.has(orderStatus)) || (numberStatus && FINAL_FAILURE.has(numberStatus))) {
    return { kind: "FAILED", orderStatus, numberStatus };
  }
  if (!requirementsMet) {
    return { kind: "REQUIREMENTS", orderStatus, numberStatus };
  }
  if (numberStatus && FINAL_SUCCESS.has(numberStatus)) {
    return { kind: "READY", orderStatus ?? "pending", numberStatus };
  }
  return { kind: "PENDING", orderStatus, numberStatus };
}


export function outboundSmsReady(readiness: string | null | undefined) {
  return readiness === "READY";
}
