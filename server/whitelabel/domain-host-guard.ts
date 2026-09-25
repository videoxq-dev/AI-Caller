import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { whitelabelDomains } from "@/db/schema";
import { requireEffectiveWhitelabelPurchaser } from "@/server/auth/commercial-ownership";
import { AppError } from "@/server/http/errors";
import { getWhitelabelDomainInfrastructure } from "./domain-config";
import { normalizeWhitelabelHostname } from "./domain-hostname";

const HOLDING_STATUSES = ["CERT_PENDING", "CERT_READY", "ACTIVE"] as const;

function hostnameFromHeader(rawHost: string) {
  const value = rawHost.trim();
  if (!value) return null;
  try {
    const url = new URL(`https://${value}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.hostname;
  } catch {
    return null;
  }
}

export async function resolveWhitelabelHoldingHost(rawHost: string) {
  const headerHostname = hostnameFromHeader(rawHost);
  if (!headerHostname) return null;

  let hostname: string;
  try {
    const { reservedHosts } = getWhitelabelDomainInfrastructure();
    hostname = normalizeWhitelabelHostname(headerHostname, reservedHosts);
  } catch (error) {
    if (error instanceof AppError
      && (error.code === "WHITELABEL_DOMAIN_INVALID" || error.code === "WHITELABEL_DOMAIN_RESERVED")) {
      return null;
    }
    throw error;
  }

  const [domain] = await db.select({
    id: whitelabelDomains.id,
    hostname: whitelabelDomains.hostname,
    purchaserUserId: whitelabelDomains.purchaserUserId,
    status: whitelabelDomains.status,
  }).from(whitelabelDomains)
    .where(and(
      eq(whitelabelDomains.hostname, hostname),
      inArray(whitelabelDomains.status, [...HOLDING_STATUSES]),
      isNotNull(whitelabelDomains.routeId),
      isNotNull(whitelabelDomains.routeProvisionedAt),
    ))
    .limit(1);
  if (!domain) return null;

  try {
    await requireEffectiveWhitelabelPurchaser(domain.purchaserUserId);
  } catch (error) {
    if (error instanceof AppError && error.code === "WHITELABEL_REQUIRED") return null;
    throw error;
  }

  return domain;
}
