import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "@/db";
import { whitelabelDomains, type WhitelabelDomainStatus } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { normalizeWhitelabelHostname } from "./domain-hostname";
import { getWhitelabelTraefikRouteConfig } from "./domain-route-config";

const ROUTE_PRESENT: WhitelabelDomainStatus[] = [
  "VERIFIED",
  "ROUTE_PROVISIONING",
  "CERT_PENDING",
  "CERT_READY",
  "ACTIVE",
];
const ROUTE_ABSENT: WhitelabelDomainStatus[] = [
  "DRAFT",
  "AWAITING_DNS",
  "DNS_MISMATCH",
  "REVOKED",
  "DISABLING",
  "DISABLED",
];

function routeIdForDomain(domainId: string) {
  return `wl-${domainId.replace(/-/g, "").toLowerCase()}`;
}

export function routeFilePathForDomain(domainId: string, dynamicDir?: string) {
  const dir = dynamicDir ?? getWhitelabelTraefikRouteConfig().dynamicDir;
  return path.join(dir, `${routeIdForDomain(domainId)}.yml`);
}

export function renderTraefikDomainRoute(input: {
  routeId: string;
  hostname: string;
  entryPoint: string;
  certResolver: string;
  serviceUrl: string;
}) {
  const hostname = normalizeWhitelabelHostname(input.hostname);
  if (!/^wl-[0-9a-f]+$/.test(input.routeId)) {
    throw new AppError("WHITELABEL_TRAEFIK_ROUTE_INVALID", "Invalid Whitelabel route identifier.", 500);
  }
  for (const [label, value] of [
    ["entry point", input.entryPoint],
    ["certificate resolver", input.certResolver],
  ] as const) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new AppError("WHITELABEL_TRAEFIK_ROUTE_INVALID", `Invalid Traefik ${label}.`, 500);
    }
  }
  const url = new URL(input.serviceUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new AppError("WHITELABEL_TRAEFIK_ROUTE_INVALID", "Invalid Traefik service URL.", 500);
  }

  return [
    "http:",
    "  routers:",
    `    ${input.routeId}:`,
    '      rule: "Host(`' + hostname + '`)"',
    "      entryPoints:",
    `        - ${input.entryPoint}`,
    `      service: ${input.routeId}`,
    "      middlewares:",
    `        - ${input.routeId}-pending`,
    "      tls:",
    `        certResolver: ${input.certResolver}`,
    "  middlewares:",
    `    ${input.routeId}-pending:`,
    "      replacePath:",
    "        path: /api/whitelabel/domain-pending",
    "  services:",
    `    ${input.routeId}:`,
    "      loadBalancer:",
    "        passHostHeader: true",
    "        servers:",
    `          - url: ${JSON.stringify(url.origin)}`,
    "",
  ].join("\n");
}

async function writeAtomic(target: string, content: string) {
  try {
    if (await readFile(target, "utf8") === content) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "w", 0o644);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    return true;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function removeRouteFile(target: string) {
  await unlink(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function reloadDomain(domainId: string) {
  const [row] = await db.select().from(whitelabelDomains)
    .where(eq(whitelabelDomains.id, domainId)).limit(1);
  if (!row) throw new AppError("WHITELABEL_DOMAIN_NOT_FOUND", "Custom domain not found.", 404);
  return row;
}

export async function reconcileWhitelabelDomainRoute(domainId: string) {
  const config = getWhitelabelTraefikRouteConfig();
  const domain = await reloadDomain(domainId);
  if (!config.enabled) return domain;

  const routeId = routeIdForDomain(domain.id);
  const target = routeFilePathForDomain(domain.id, config.dynamicDir);

  if (ROUTE_ABSENT.includes(domain.status)) {
    await removeRouteFile(target);
    const [updated] = await db.update(whitelabelDomains).set({
      routeId: null,
      routeProvisionedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(whitelabelDomains.id, domain.id),
      eq(whitelabelDomains.status, domain.status),
    )).returning();
    if (updated) return updated;
    throw new AppError(
      "WHITELABEL_DOMAIN_ROUTE_STATE_CHANGED",
      "The custom-domain lifecycle changed while its route was being removed. Retry reconciliation.",
      409,
    );
  }

  if (!ROUTE_PRESENT.includes(domain.status) || !domain.dnsVerifiedAt) {
    throw new AppError(
      "WHITELABEL_DOMAIN_ROUTE_NOT_READY",
      "DNS ownership and routing must be verified before the custom-domain route can be provisioned.",
      409,
    );
  }

  const yaml = renderTraefikDomainRoute({
    routeId,
    hostname: domain.hostname,
    entryPoint: config.entryPoint,
    certResolver: config.certResolver,
    serviceUrl: config.serviceUrl,
  });

  try {
    await writeAtomic(target, yaml);
  } catch (error) {
    await db.update(whitelabelDomains).set({
      lastErrorCode: "TRAEFIK_ROUTE_WRITE_FAILED",
      lastErrorMessage: "The edge route could not be written. AI Caller will retry automatically.",
      updatedAt: new Date(),
    }).where(and(
      eq(whitelabelDomains.id, domain.id),
      eq(whitelabelDomains.status, domain.status),
    ));
    throw error;
  }

  const now = new Date();
  const enteringCertificatePending = domain.status === "VERIFIED" || domain.status === "ROUTE_PROVISIONING";
  const nextStatus = enteringCertificatePending ? "CERT_PENDING" as const : domain.status;
  const nextCertificateStatus = enteringCertificatePending
    ? "PENDING" as const
    : domain.certificateStatus;

  const [updated] = await db.update(whitelabelDomains).set({
    status: nextStatus,
    certificateStatus: nextCertificateStatus,
    certificateReadyAt: enteringCertificatePending ? null : domain.certificateReadyAt,
    certificateExpiresAt: enteringCertificatePending ? null : domain.certificateExpiresAt,
    routeId,
    routeProvisionedAt: domain.routeProvisionedAt ?? now,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: now,
  }).where(and(
    eq(whitelabelDomains.id, domain.id),
    eq(whitelabelDomains.status, domain.status),
  )).returning();

  if (!updated) {
    await removeRouteFile(target);
    throw new AppError(
      "WHITELABEL_DOMAIN_ROUTE_STATE_CHANGED",
      "The custom-domain lifecycle changed while its route was being provisioned. The stale route was removed.",
      409,
    );
  }
  return updated;
}

export async function recoverWhitelabelDomainRoutes(limit = 100) {
  const config = getWhitelabelTraefikRouteConfig();
  if (!config.enabled) return { checked: 0, materialized: 0, removed: 0, failed: 0 };

  const rows = await db.select({ id: whitelabelDomains.id, status: whitelabelDomains.status })
    .from(whitelabelDomains)
    .where(or(
      inArray(whitelabelDomains.status, ROUTE_PRESENT),
      and(
        inArray(whitelabelDomains.status, ROUTE_ABSENT),
        isNotNull(whitelabelDomains.routeId),
      ),
    ))
    .orderBy(asc(whitelabelDomains.updatedAt), asc(whitelabelDomains.id))
    .limit(Math.max(1, Math.min(limit, 500)));

  let materialized = 0;
  let removed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await reconcileWhitelabelDomainRoute(row.id);
      if (ROUTE_PRESENT.includes(row.status)) materialized += 1;
      else removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { checked: rows.length, materialized, removed, failed };
}
