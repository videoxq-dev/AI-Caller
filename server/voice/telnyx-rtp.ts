import { randomBytes } from "node:crypto";

// Telnyx's inbound media.payload is the RTP PAYLOAD with headers removed.
// Its bidirectional rtp mode expects whole RTP PACKETS on output.
const PCMU_PAYLOAD_TYPE = 0;
const PCMU_SAMPLE_RATE = 8000;
export const PCMU_FRAME_SAMPLES = 160; // 20ms, mono 8kHz G.711 mu-law

export class TelnyxPcmuRtpPacketizer {
  private sequence = randomBytes(2).readUInt16BE(0);
  private timestamp = randomBytes(4).readUInt32BE(0);
  private readonly ssrc = randomBytes(4).readUInt32BE(0);

  packet(audio: Buffer): Buffer {
    if (audio.length !== PCMU_FRAME_SAMPLES) {
      throw new Error("Expected exactly 20ms of 8kHz PCMU.");
    }
    const packet = Buffer.allocUnsafe(12 + PCMU_FRAME_SAMPLES);
    packet[0] = 0x80; // RTP v2, no extensions / CSRC list
    packet[1] = PCMU_PAYLOAD_TYPE; // G.711 PCMU, no marker
    packet.writeUInt16BE(this.sequence, 2);
    packet.writeUInt32BE(this.timestamp, 4);
    packet.writeUInt32BE(this.ssrc, 8);
    audio.copy(packet, 12);
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + PCMU_FRAME_SAMPLES) >>> 0;
    return packet;
  }

  get sampleRate() { return PCMU_SAMPLE_RATE; }
}
