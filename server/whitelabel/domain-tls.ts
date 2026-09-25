import https from "node:https";
import type { TLSSocket } from "node:tls";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
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

export async function probeWhitelabelDomainTls(hostname: string): Promise<WhitelabelTlsProbeResult> {
  const env = getEnv();
  const infra = getWhitelabelDomainInfrastructure(true);
  const edgeIp = infra.ipv4;
  if (!edgeIp) {
    return probeFailure("TLS_EDGE_NOT_CONFIGURED", "The Whitelabel public edge is not configured.");
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: WhitelabelTlsProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = https.request({
      hostname: edgeIp,
      port: 443,
      method: "GET",
      path: "/",
      servername: hostname,
      rejectUnauthorized: true,
      headers: {
        host: hostname,
        accept: "application/json",
        "user-agent": "AI-Caller-Whitelabel-TLS-Probe/1.0",
      },
      timeout: env.WHITELABEL_TLS_PROBE_TIMEOUT_MS,
    }, (response) => {
      const socket = response.socket as TLSSocket;
      const certificate = socket.getPeerCertificate();
      const statusCode = response.statusCode ?? 0;
      response.resume();

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

      finish({ ok: true, statusCode, expiresAt });
    });

    request.on("timeout", () => {
      request.destroy(new Error("TLS probe timed out."));
    });
    request.on("error", (error) => {
      finish(probeFailure(
        "TLS_PROBE_FAILED",
        error instanceof Error && error.message
          ? `HTTPS is not ready yet: ${error.message}`
          : "HTTPS is not ready yet.",
      ));
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

  const probe = await prober(domain.hostname);
  const now = new Date();

  if (!probe.ok) {
    const [updated] = await db.update(whitelabelDomains).set({
      lastErrorCode: probe.code,
      lastErrorMessage: probe.message,
      updatedAt: now,
    }).where(and(
      eq(whitelabelDomains.id, domain.id),
      eq(whitelabelDomains.status, domain.status),
      eq(whitelabelDomains.routeId, domain.routeId),
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
    eq(whitelabelDomains.routeId, domain.routeId),
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
  limit = 100,
  prober: WhitelabelTlsProber = probeWhitelabelDomainTls,
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
    .limit(Math.max(1, Math.min(limit, 500)));

  let ready = 0;
  let pending = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await reconcileWhitelabelDomainTls(row.id, prober);
      if (result.status === "CERT_READY" || result.status === "ACTIVE") ready += 1;
      else pending += 1;
    } catch {
      failed += 1;
    }
  }
  return { checked: rows.length, ready, pending, failed };
}
