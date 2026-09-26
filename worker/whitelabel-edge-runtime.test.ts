import { describe, expect, it } from "vitest";
import {
  createWhitelabelReconcileTimer,
  nextWhitelabelRouteScanOffset,
} from "./whitelabel-edge-runtime";

describe("Whitelabel edge recovery pagination", () => {
  it("advances by a full unchanged page", () => {
    expect(nextWhitelabelRouteScanOffset(0, { checked: 100, removed: 0 })).toBe(100);
    expect(nextWhitelabelRouteScanOffset(100, { checked: 100, removed: 0 })).toBe(200);
  });

  it("subtracts rows removed from the recovery query so shifted domains are not skipped", () => {
    expect(nextWhitelabelRouteScanOffset(0, { checked: 100, removed: 12 })).toBe(88);
    expect(nextWhitelabelRouteScanOffset(100, { checked: 100, removed: 100 })).toBe(100);
  });

  it("resets after the final short page", () => {
    expect(nextWhitelabelRouteScanOffset(300, { checked: 37, removed: 5 })).toBe(0);
  });

  it("keeps the dedicated reconciler process alive between scans", () => {
    const timer = createWhitelabelReconcileTimer(() => undefined, 60_000);
    try {
      expect(timer.hasRef()).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });
});
