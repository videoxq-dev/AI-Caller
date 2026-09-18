import { createPublicKey, verify, type KeyObject } from "node:crypto";

export function parseTelnyxWebhookPublicKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Telnyx webhook public key is required.");
  const key = trimmed.includes("BEGIN PUBLIC KEY")
    ? createPublicKey(trimmed)
    : (() => {
        const raw = Buffer.from(trimmed, "base64");
        if (raw.length !== 32) throw new Error("Telnyx webhook public key must be a 32-byte Ed25519 key or PEM public key.");
        const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
        return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
      })();
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Telnyx webhook public key must be an Ed25519 public key.");
  return key;
}

export function verifyTelnyxWebhookSignature(request: Request, rawBody: string, publicKey: KeyObject) {
  const timestamp = request.headers.get("telnyx-timestamp") ?? request.headers.get("webhook-timestamp");
  const signature = request.headers.get("telnyx-signature-ed25519") ?? request.headers.get("webhook-signature");
  if (!timestamp || !signature) return false;
  const epochSeconds = Number(timestamp);
  if (!Number.isFinite(epochSeconds) || Math.abs(Date.now() / 1000 - epochSeconds) > 300) return false;
  try {
    return verify(null, Buffer.from(`${timestamp}|${rawBody}`, "utf8"), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
