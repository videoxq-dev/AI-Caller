import { describe, expect, it } from "vitest";
import { PCMU_FRAME_SAMPLES, TelnyxPcmuRtpPacketizer } from "./telnyx-rtp";

describe("Telnyx bidirectional RTP", () => {
  it("wraps 20ms PCMU in RTP v2 with monotonically increasing timing", () => {
    const rtp = new TelnyxPcmuRtpPacketizer();
    const audio = Buffer.alloc(PCMU_FRAME_SAMPLES, 0x7f);
    const one = rtp.packet(audio);
    const two = rtp.packet(audio);
    expect(one.length).toBe(172);
    expect(one[0]).toBe(0x80);
    expect(one[1]).toBe(0);
    expect(one.subarray(12)).toEqual(audio);
    expect(two.subarray(12)).toEqual(audio);
    expect(two.readUInt16BE(2)).toBe((one.readUInt16BE(2) + 1) & 0xffff);
    expect(two.readUInt32BE(4)).toBe((one.readUInt32BE(4) + 160) >>> 0);
    expect(two.readUInt32BE(8)).toBe(one.readUInt32BE(8));
    expect(rtp.sampleRate).toBe(8000);
  });
  it("rejects incomplete and oversized PCMU packets", () => {
    const rtp = new TelnyxPcmuRtpPacketizer();
    expect(() => rtp.packet(Buffer.alloc(159))).toThrow("20ms");
    expect(() => rtp.packet(Buffer.alloc(161))).toThrow("20ms");
  });
});
