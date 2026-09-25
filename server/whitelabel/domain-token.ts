import { randomBytes } from "node:crypto";
import { getEnv } from "@/server/env";
import {
  createSecretBox,
  type EncryptedSecretEnvelope,
} from "@/server/security/secrets";

function box() {
  return createSecretBox(getEnv().INTEGRATION_ENCRYPTION_KEY);
}

export function newWhitelabelDomainVerificationToken() {
  return randomBytes(24).toString("base64url");
}

export function encryptWhitelabelDomainVerificationToken(token: string) {
  return box().encrypt({ token }) as unknown as Record<string, unknown>;
}

export function decryptWhitelabelDomainVerificationToken(value: Record<string, unknown>) {
  return box().decrypt<{ token: string }>(value as EncryptedSecretEnvelope).token;
}
