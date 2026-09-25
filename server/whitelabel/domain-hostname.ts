import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { AppError } from "@/server/http/errors";

function hostnameFromInput(raw: string) {
  const value = raw.trim();
  if (!value) throw new AppError("WHITELABEL_DOMAIN_INVALID", "Enter a custom subdomain.", 422);
  let url: URL;
  try {
    url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
  } catch {
    throw new AppError("WHITELABEL_DOMAIN_INVALID", "Enter a valid custom subdomain.", 422);
  }
  if (url.username || url.password || url.port || url.search || url.hash
    || (url.pathname && url.pathname !== "/")) {
    throw new AppError("WHITELABEL_DOMAIN_INVALID", "Enter only the hostname, without a path, port or credentials.", 422);
  }
  return url.hostname.replace(/\.$/, "").toLowerCase();
}

export function normalizeWhitelabelHostname(raw: string, reservedHosts: string[] = []) {
  const input = hostnameFromInput(raw);
  const hostname = domainToASCII(input);
  if (!hostname || hostname.length > 253 || isIP(hostname) !== 0 || hostname.includes("*")) {
    throw new AppError("WHITELABEL_DOMAIN_INVALID", "Enter a valid public subdomain.", 422);
  }
  const labels = hostname.split(".");
  if (labels.length < 3 || labels.some((label) =>
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new AppError("WHITELABEL_DOMAIN_INVALID", "Whitelabel domains must be valid public subdomains.", 422);
  }
  const blockedSuffixes = [".localhost", ".local", ".internal", ".invalid", ".test"];
  if (blockedSuffixes.some((suffix) => hostname.endsWith(suffix))) {
    throw new AppError("WHITELABEL_DOMAIN_INVALID", "Use a public DNS hostname.", 422);
  }
  for (const reservedRaw of reservedHosts) {
    const reserved = domainToASCII(reservedRaw.trim().replace(/\.$/, "").toLowerCase());
    if (reserved && (hostname === reserved || hostname.endsWith(`.${reserved}`))) {
      throw new AppError("WHITELABEL_DOMAIN_RESERVED", "That hostname is reserved by AI Caller.", 422);
    }
  }
  return hostname;
}
