import { describe, expect, it } from "vitest";
import { carrierProvisioningOutcome, outboundSmsReady } from "./lifecycle";

describe("managed phone lifecycle", () => {
  it("does not consider a carrier number ready while the individual ordered number is pending", () => {
    expect(carrierProvisioningOutcome(
      { id: "order-1", status: "pending", requirements_met: true },
      { id: "ordered-number-1", status: "pending", requirements_met: true },
    )).toMatchObject({ kind: "PENDING" });

    expect(carrierProvisioningOutcome(
      { id: "order-1", status: "success", requirements_met: true },
      { id: "ordered-number-1", status: "pending", requirements_met: true },
    )).toMatchObject({ kind: "PENDING" });
  });

  it("accepts individual-number success even while the parent order remains pending", () => {
    expect(carrierProvisioningOutcome(
      { id: "order-1", status: "pending", requirements_met: true },
      { id: "ordered-number-1", status: "success", requirements_met: true },
    )).toEqual({ kind: "READY", orderStatus: "pending", numberStatus: "success" });
  });

  it("surfaces carrier failure and requirements separately", () => {
    expect(carrierProvisioningOutcome(
      { id: "order-1", status: "failure", requirements_met: true },
      { id: "ordered-number-1", status: "failure", requirements_met: true },
    )).toMatchObject({ kind: "FAILED" });

    expect(carrierProvisioningOutcome(
      { id: "order-1", status: "pending", requirements_met: false },
      { id: "ordered-number-1", status: "pending", requirements_met: false },
    )).toMatchObject({ kind: "REQUIREMENTS" });
  });

  it("allows hosted outbound SMS only after readiness is READY", () => {
    expect(outboundSmsReady("READY")).toBe(true);
    expect(outboundSmsReady("NOT_REGISTERED")).toBe(false);
    expect(outboundSmsReady("PENDING")).toBe(false);
    expect(outboundSmsReady("REJECTED")).toBe(false);
  });
});
