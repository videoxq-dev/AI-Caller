import { isIP } from "node:net";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";

export function getWhitelabelDomainInfrastructure(requirePublicIp = false) {
  const env = getEnv();
  const ipv4 = env.WHITELABEL_PUBLIC_IPV4?.trim();
  if (ipv4 && isIP(ipv4) !== 4) {
    throw new AppError(
      "WHITELABEL_DOMAIN_INFRASTRUCTURE_NOT_CONFIGURED",
      "The configured custom-domain IPv4 address is invalid.",
      503,
    );
  }
  if (requirePublicIp && !ipv4) {
    throw new AppError(
      "WHITELABEL_DOMAIN_INFRASTRUCTURE_NOT_CONFIGURED",
      "Custom domains are not configured on this AI Caller server yet.",
      503,
    );
  }
  const ipv6 = env.WHITELABEL_PUBLIC_IPV6?.trim() || null;
  if (ipv6 && isIP(ipv6) !== 6) {
    throw new AppError(
      "WHITELABEL_DOMAIN_INFRASTRUCTURE_NOT_CONFIGURED",
      "The configured custom-domain IPv6 address is invalid.",
      503,
    );
  }
  const authHost = (() => {
    try { return new URL(env.BETTER_AUTH_URL).hostname; } catch { return ""; }
  })();
  const reservedHosts = [
    env.WHITELABEL_CANONICAL_HOST ?? "",
    authHost,
    ...env.WHITELABEL_RESERVED_HOSTS.split(","),
  ].filter(Boolean);
  return { ipv4: ipv4 ?? null, ipv6, reservedHosts };
}
