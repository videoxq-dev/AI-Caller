import { isE2EProviderFixtureMode } from "@/server/providers/e2e-fixtures";

function wavSilence(durationMs = 8000, sampleRate = 8000) {
  const samples = Math.max(1, Math.round(sampleRate * durationMs / 1000));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

export async function GET() {
  if (!isE2EProviderFixtureMode()) return new Response("Not found", { status: 404 });
  return new Response(wavSilence(), {
    headers: {
      "content-type": "audio/wav",
      "cache-control": "no-store",
    },
  });
}
