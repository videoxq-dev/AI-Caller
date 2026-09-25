import { eq } from "drizzle-orm";
import { db } from "@/db";
import { whitelabelDomains } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { reconcileWhitelabelDomainDns } from "./domain-dns";
import { reconcileWhitelabelDomainRoute } from "./domain-route";

const ROUTE_REMOVAL_STATES = new Set(["DNS_MISMATCH", "REVOKED", "DISABLING", "DISABLED"]);

export async function reconcileWhitelabelDomain(domainId: string) {
  const [current] = await db.select().from(whitelabelDomains)
    .where(eq(whitelabelDomains.id, domainId)).limit(1);
  if (!current) throw new AppError("WHITELABEL_DOMAIN_NOT_FOUND", "Custom domain not found.", 404);

  if (ROUTE_REMOVAL_STATES.has(current.status)) {
    return reconcileWhitelabelDomainRoute(domainId);
  }

  const dns = await reconcileWhitelabelDomainDns(domainId);
  if (dns.status === "AWAITING_DNS" || dns.status === "DRAFT") return dns;
  return reconcileWhitelabelDomainRoute(domainId);
}
