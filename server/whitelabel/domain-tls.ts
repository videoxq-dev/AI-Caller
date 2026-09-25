import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { whitelabelDomains } from "@/db/schema";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import { getWhitelabelDomainInfrastructure } from "./domain-config";

export type WhitelabelTlsProbeResult =
  | { ok: true; statusCode: number; expiresAt: Date }
  | { ok: false; code: string; message: string };

export type WhitelabelTlsProber = (hostname: string) => Promise<WhitelabelTlsProbeResult>;

function probeFailure(code: string, message: string): WhitelabelTlsProbeResult {
  return { ok: false, code, message };
}


export function classifyWhitelabelTlsProbeError(error: unknown): WhitelabelTlsProbeResult {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const certificateCodes = new Set([
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  ]);
  if (certificateCodes.has(code)) {
    return probeFailure(
      "TLS_CERT_NOT_READY",
      "The edge certificate is not trusted for this custom hostname yet.",
    );
  }
  return probeFailure(
    "TLS_PROBE_FAILED",
    error instanceof Error && error.message
      ? `HTTPS is not ready yet: ${error.message}`
      : "HTTPS is not ready yet.",
  );
}

export function buildWhitelabelTlsProbeTarget(hostname: string) {
  const infra = getWhitelabelDomainInfrastructure(true);
  if (!infra.ipv4) {
    throw new AppError("TLS_EDGE_NOT_CONFIGURED", "The Whitelabel public edge is not configured.", 503);
  }
  return {
    connectHostname: infra.ipv4,
    servername: hostname,
    hostHeader: hostname,
  };
}

export async function probeWhitelabelDomainTls(hostname: string): Promise<WhitelabelTlsProbeResult> {
  const env = getEnv();
  let target: ReturnType<typeof buildWhitelabelTlsProbeTarget>;
  try {
    target = buildWhitelabelTlsProbeTarget(hostname);
  } catch {
    return probeFailure("TLS_EDGE_NOT_CONFIGURED", "The Whitelabel public edge is not configured.");
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: WhitelabelTlsProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = httpsRequest({
      hostname: target.connectHostname,
      port: 443,
      method: "GET",
      path: "/",
      servername: target.servername,
      rejectUnauthorized: true,
      headers: {
        host: target.hostHeader,
        accept: "application/json",
        "user-agent": "AI-Caller-Whitelabel-TLS-Probe/1.0",
      },
      timeout: env.WHITELABEL_TLS_PROBE_TIMEOUT_MS,
    }, (response) => {
      const socket = response.socket as TLSSocket;
      const certificate = socket.getPeerCertificate();
      const statusCode = response.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let size = 0;

      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size <= 4096) chunks.push(buffer);
      });
      response.on("end", () => {
        if (!socket.authorized) {
          finish(probeFailure(
            "TLS_CERT_NOT_READY",
            "The edge certificate is not trusted for this custom hostname yet.",
          ));
          return;
        }

        const expiresAt = certificate.valid_to ? new Date(certificate.valid_to) : null;
        if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
          finish(probeFailure(
            "TLS_CERT_INVALID",
            "The custom-domain certificate is missing a valid future expiration date.",
          ));
          return;
        }

        if (statusCode < 200 || statusCode >= 400) {
          finish(probeFailure(
            "TLS_HTTP_NOT_READY",
            `HTTPS reached the edge but returned status ${statusCode}.`,
          ));
          return;
        }

        if (size > 4096) {
          finish(probeFailure(
            "TLS_ROUTE_NOT_READY",
            "HTTPS is active but the expected Whitelabel edge response was not returned.",
          ));
          return;
        }

        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = null;
        }
        if (!body || typeof body !== "object"
          || !("status" in body) || (body as { status?: unknown }).status !== "domain-ready"
          || !("host" in body)
          || String((body as { host?: unknown }).host).split(":")[0].toLowerCase() !== hostname.toLowerCase()) {
          finish(probeFailure(
            "TLS_ROUTE_NOT_READY",
            "HTTPS is active but the custom hostname has not reached the Whitelabel holding route yet.",
          ));
          return;
        }

        finish({ ok: true, statusCode, expiresAt });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("TLS probe timed out."));
    });
    request.on("error", (error) => {
      finish(classifyWhitelabelTlsProbeError(error));
    });
    request.end();
  });
}

export async function reconcileWhitelabelDomainTls(
  domainId: string,
  prober: WhitelabelTlsProber = probeWhitelabelDomainTls,
) {
  const [domain] = await db.select().from(whitelabelDomains)
    .where(eq(whitelabelDomains.id, domainId))
    .limit(1);
  if (!domain) {
    throw new AppError("WHITELABEL_DOMAIN_NOT_FOUND", "Custom domain not found.", 404);
  }
  if (!["CERT_PENDING", "CERT_READY", "ACTIVE"].includes(domain.status)
    || !domain.routeProvisionedAt || !domain.routeId) {
    throw new AppError(
      "WHITELABEL_DOMAIN_TLS_NOT_READY",
      "The custom-domain edge route must be provisioned before TLS can be verified.",
      409,
    );
  }

  const routeId = domain.routeId;
  const probe = await prober(domain.hostname);
  const now = new Date();

  if (!probe.ok) {
    const expired = Boolean(domain.certificateExpiresAt
      && domain.certificateExpiresAt.getTime() <= now.getTime());
    const [updated] = await db.update(whitelabelDomains).set({
      status: expired ? "CERT_PENDING" : domain.status,
      certificateStatus: expired ? "FAILED" : domain.certificateStatus,
      lastErrorCode: probe.code,
      lastErrorMessage: probe.message,
      updatedAt: now,
    }).where(and(
      eq(whitelabelDomains.id, domain.id),
      eq(whitelabelDomains.status, domain.status),
      eq(whitelabelDomains.routeId, routeId),
    )).returning();

    if (!updated) {
      throw new AppError(
        "WHITELABEL_DOMAIN_TLS_STATE_CHANGED",
        "The custom-domain lifecycle changed while TLS was being checked.",
        409,
      );
    }
    return updated;
  }

  const nextStatus = domain.status === "CERT_PENDING" ? "CERT_READY" as const : domain.status;
  const [updated] = await db.update(whitelabelDomains).set({
    status: nextStatus,
    certificateStatus: "READY",
    certificateReadyAt: domain.certificateReadyAt ?? now,
    certificateExpiresAt: probe.expiresAt,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: now,
  }).where(and(
    eq(whitelabelDomains.id, domain.id),
    eq(whitelabelDomains.status, domain.status),
    eq(whitelabelDomains.routeId, routeId),
  )).returning();

  if (!updated) {
    throw new AppError(
      "WHITELABEL_DOMAIN_TLS_STATE_CHANGED",
      "The custom-domain lifecycle changed while TLS was being checked.",
      409,
    );
  }
  return updated;
}

export async function reconcilePendingWhitelabelDomainCertificates(
  limit = 40,
  prober: WhitelabelTlsProber = probeWhitelabelDomainTls,
  concurrency = 8,
) {
  const renewalAuditThreshold = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
  const rows = await db.select({ id: whitelabelDomains.id })
    .from(whitelabelDomains)
    .where(or(
      eq(whitelabelDomains.status, "CERT_PENDING"),
      and(
        inArray(whitelabelDomains.status, ["CERT_READY", "ACTIVE"]),
        or(
          isNull(whitelabelDomains.certificateExpiresAt),
          lte(whitelabelDomains.certificateExpiresAt, renewalAuditThreshold),
        ),
      ),
    ))
    .orderBy(asc(whitelabelDomains.updatedAt), asc(whitelabelDomains.id))
    .limit(Math.max(1, Math.min(limit, 500)));

  let ready = 0;
  let pending = 0;
  let failed = 0;
  let nextIndex = 0;
  const workerCount = Math.min(rows.length, Math.max(1, Math.min(concurrency, 16)));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < rows.length) {
      const row = rows[nextIndex];
      nextIndex += 1;
      try {
        const result = await reconcileWhitelabelDomainTls(row.id, prober);
        if (result.status === "CERT_READY" || result.status === "ACTIVE") ready += 1;
        else pending += 1;
      } catch {
        failed += 1;
      }
    }
  }));

  return { checked: rows.length, ready, pending, failed };
}
