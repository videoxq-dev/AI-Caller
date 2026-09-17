import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "@/server/env";

const ALGORITHM = "aes-256-gcm";
const AAD = Buffer.from("ai-caller/provider-credentials/v1", "utf8");

export type EncryptedSecretEnvelope = {
  version: 1;
  algorithm: "A256GCM";
  iv: string;
  tag: string;
  ciphertext: string;
};

function decodeKey(value: string | Buffer): Buffer {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("Integration encryption key must decode to exactly 32 bytes.");
  }
  return key;
}

export function createSecretBox(keyInput: string | Buffer) {
  const key = decodeKey(keyInput);

  return {
    encrypt<T>(value: T): EncryptedSecretEnvelope {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      return {
        version: 1,
        algorithm: "A256GCM",
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    },

    decrypt<T>(envelope: EncryptedSecretEnvelope): T {
      if (envelope.version !== 1 || envelope.algorithm !== "A256GCM") {
        throw new Error("Unsupported encrypted secret format.");
      }

      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);

      return JSON.parse(plaintext.toString("utf8")) as T;
    },
  };
}

export function encryptIntegrationCredentials<T>(value: T): EncryptedSecretEnvelope {
  return createSecretBox(getEnv().INTEGRATION_ENCRYPTION_KEY).encrypt(value);
}

export function decryptIntegrationCredentials<T>(value: EncryptedSecretEnvelope): T {
  return createSecretBox(getEnv().INTEGRATION_ENCRYPTION_KEY).decrypt<T>(value);
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return `••••••••${value.slice(-4)}`;
}
