import type { Capability } from "./contracts";

const providerCapabilities: Record<string, readonly Capability[]> = {
  credits: ["AI_TEXT"],
  openai: ["AI_TEXT"],
  gemini: ["AI_TEXT"],
  openrouter: ["AI_TEXT"],
  plivo: ["SMS"],
  telnyx: ["SMS", "VOICE"],
  twilio: ["SMS"],
  whatsapp: ["WHATSAPP"],
  google: ["CALENDAR"],
  outlook: ["CALENDAR"],
  calendly: ["CALENDAR"],
  calcom: ["CALENDAR"],
};

export function providerSupportsCapability(provider: string, capability: Capability) {
  return providerCapabilities[provider]?.includes(capability) ?? false;
}

export function assertProviderSupportsCapability(provider: string, capability: Capability) {
  if (!providerSupportsCapability(provider, capability)) {
    throw new Error(`${provider} cannot be used for ${capability}.`);
  }
}

export function capabilitiesForProvider(provider: string) {
  return providerCapabilities[provider] ?? [];
}
