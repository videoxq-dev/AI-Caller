import { describe, expect, it } from "vitest";
import { createSecretBox, maskSecret } from "./secrets";

describe("provider secret encryption", () => {
  it("round trips credentials with authenticated encryption", () => {
    const key = Buffer.alloc(32, 7);
    const box = createSecretBox(key);
    const credentials = { apiKey: "sk-test-123456789", accountId: "acct_123" };

    const encrypted = box.encrypt(credentials);
    expect(encrypted.ciphertext).not.toContain(credentials.apiKey);
    expect(box.decrypt<typeof credentials>(encrypted)).toEqual(credentials);
  });

  it("rejects tampered ciphertext", () => {
    const box = createSecretBox(Buffer.alloc(32, 9));
    const encrypted = box.encrypt({ token: "secret" });
    encrypted.ciphertext = Buffer.from("tampered").toString("base64");

    expect(() => box.decrypt(encrypted)).toThrow();
  });

  it("masks stored secrets for browser metadata", () => {
    expect(maskSecret("1234567890")).toBe("••••••••7890");
  });
});
