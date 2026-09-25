import { getEnv } from "@/server/env";

export function normalizeIncomingHost(rawHost: string | null) {
  const value = rawHost?.trim() ?? "";
  if (!value || /[\s/?#@]/.test(value)) return null;
  try {
    const hostname = new URL(`http://${value}`).hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
    return hostname || null;
  } catch {
    return null;
  }
}

function configuredCanonicalHosts() {
  const env = getEnv();
  const hosts = new Set<string>();
  try {
    const authHost = new URL(env.BETTER_AUTH_URL).hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
    if (authHost) hosts.add(authHost);
  } catch {
    // BETTER_AUTH_URL is already schema-validated; keep the guard fail-closed.
  }
  const configured = normalizeIncomingHost(env.WHITELABEL_CANONICAL_HOST ?? null);
  if (configured) hosts.add(configured);
  return hosts;
}

export function isCanonicalAiCallerHost(rawHost: string | null) {
  const hostname = normalizeIncomingHost(rawHost);
  if (!hostname) return false;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  return configuredCanonicalHosts().has(hostname);
}
