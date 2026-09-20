import { describe, expect, it } from "vitest";
import { defaultAgentCapabilities } from "@/server/agent/capabilities";
import { realtimeToolsForCapabilities } from "./realtime-tools";

describe("Realtime voice capability dependency", () => {
  it("allows actual availability checks while booking is disabled", () => {
    const tools = realtimeToolsForCapabilities({
      ...defaultAgentCapabilities, BOOK_APPOINTMENT: false,
    }).map(tool => tool.name);
    expect(tools).toContain("capture_booking_details");
    expect(tools).toContain("check_availability");
    expect(tools).not.toContain("book_appointment");
  });

  it("hides booking data collection if neither availability nor booking is enabled", () => {
    const tools = realtimeToolsForCapabilities({
      ...defaultAgentCapabilities, BOOK_APPOINTMENT: false,
      CHECK_AVAILABILITY: false,
    }).map(tool => tool.name);
    expect(tools).not.toContain("capture_booking_details");
    expect(tools).not.toContain("check_availability");
    expect(tools).not.toContain("book_appointment");
    expect(tools).toContain("escalate_to_staff");
  });
});
