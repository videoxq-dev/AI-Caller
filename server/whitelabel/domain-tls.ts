import https from "node:https";
import type { TLSSocket } from "node:tls";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { whitelabelDomains } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { normalizeWhitelabelHostname } from "./domain-hostname";

export type WhitelabelTlsProbeResult = {
  statusCode: number;
  returnedHost: string;
  certificateExpiresAt: Date;
};

export type WhitelabelTlsProbe = (hostname: string) => Promise<WhitelabelTlsProbeResult>;

export const probeWhitelabelTls: WhitelabelTlsProbe = async (hostname) => new Promise((resolve, reject) => {
  const request = https.request({
    hostname,
    port: 443,
    path: "/api/domain-ready",
    method: "GET",
    servername: hostname,
    rejectUnauthorized: true,
    timeout: 5_000,
    headers: {
      accept: "application/json",
      "user-agent": "AI-Caller-Whitelabel-TLS-Probe/1",
    },
  }, (response) => {
    const socket = response.socket as TLSSocket;
    const certificate = socket.getPeerCertificate();
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      if (body.length < 4_096) body += chunk.slice(0, 4_096 - body.length);
    });
    response.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { host?: unknown };
        const validTo = certificate.valid_to ? new Date(certificate.valid_to) : new Date(Number.NaN);
        resolve({
          statusCode: response.statusCode ?? 0,
          returnedHost: typeof parsed.host === "string" ? parsed.host : "",
          certificateExpiresAt: validTo,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
  request.on("timeout", () => request.destroy(new Error("TLS probe timed out.")));
  request.on("error", reject);
  request.end();
});

function normalizedReturnedHost(value: string) {
  const host = value.trim().replace(/:\d+$/, "");
  return normalizeWhitelabelHostname(host);
}

async function markTlsFailure(
  domainId: string,
  code: string,
  message: string,
) {
  const now = new Date();
  const [updated] = await db.update(whitelabelDomains).set({
    certificateStatus: "FAILED",
    certificateReadyAt: null,
    lastCheckedAt: now,
    lastErrorCode: code,
    lastErrorMessage: message,
    updatedAt: now,
  }).where(and(
    eq(whitelabelDomains.id, domainId),
    eq(whitelabelDomains.status, "CERT_PENDING"),
  )).returning();
  if (!updated) {
    throw new AppError(
      "WHITELABEL_DOMAIN_TLS_STATE_CHANGED",
      "The custom-domain lifecycle changed while HTTPS readiness was being checked.",
      409,
    );
  }
  return updated;
}

export async function verifyWhitelabelDomainTls(
  domainId: string,
  probe: WhitelabelTlsProbe = probeWhitelabelTls,
) {
  const [domain] = await db.select().from(whitelabelDomains)
    .where(eq(whitelabelDomains.id, domainId))
    .limit(1);
  if (!domain) throw new AppError("WHITELABEL_DOMAIN_NOT_FOUND", "Custom domain not found.", 404);
  if (domain.status !== "CERT_PENDING"
    || !domain.dnsVerifiedAt
    || !domain.routeId
    || !domain.routeProvisionedAt) {
    throw new AppError(
      "WHITELABEL_DOMAIN_TLS_NOT_READY",
      "The custom domain must have verified DNS and a provisioned route before HTTPS can be accepted.",
      409,
    );
  }

  let result: WhitelabelTlsProbeResult;
  try {
    result = await probe(domain.hostname);
  } catch {
    return markTlsFailure(
      domain.id,
      "TLS_PROBE_FAILED",
      "HTTPS is not ready yet. AI Caller will retry automatically.",
    );
  }

  if (result.statusCode !== 200) {
    return markTlsFailure(
      domain.id,
      "TLS_HTTP_NOT_READY",
      "The custom hostname did not return the AI Caller readiness endpoint successfully.",
    );
  }

  let returnedHost = "";
  try {
    returnedHost = normalizedReturnedHost(result.returnedHost);
  } catch {
    return markTlsFailure(
      domain.id,
      "TLS_HOST_MISMATCH",
      "The HTTPS route did not preserve the expected custom hostname.",
    );
  }
  if (returnedHost !== domain.hostname) {
    return markTlsFailure(
      domain.id,
      "TLS_HOST_MISMATCH",
      "The HTTPS route did not preserve the expected custom hostname.",
    );
  }

  if (Number.isNaN(result.certificateExpiresAt.getTime())
    || result.certificateExpiresAt.getTime() <= Date.now()) {
    return markTlsFailure(
      domain.id,
      "TLS_CERTIFICATE_INVALID",
      "The HTTPS certificate is missing a valid future expiration date.",
    );
  }

  const now = new Date();
  const [updated] = await db.update(whitelabelDomains).set({
    status: "CERT_READY",
    certificateStatus: "READY",
    certificateReadyAt: now,
    certificateExpiresAt: result.certificateExpiresAt,
    lastCheckedAt: now,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: now,
  }).where(and(
    eq(whitelabelDomains.id, domain.id),
    eq(whitelabelDomains.status, "CERT_PENDING"),
  )).returning();

  if (!updated) {
    throw new AppError(
      "WHITELABEL_DOMAIN_TLS_STATE_CHANGED",
      "The custom-domain lifecycle changed while HTTPS readiness was being accepted.",
      409,
    );
  }
  return updated;
}

export async function processPendingWhitelabelTlsChecks(
  limit = 50,
  probe: WhitelabelTlsProbe = probeWhitelabelTls,
) {
  const cutoff = new Date(Date.now() - 20_000);
  const rows = await db.select({ id: whitelabelDomains.id })
    .from(whitelabelDomains)
    .where(and(
      eq(whitelabelDomains.status, "CERT_PENDING"),
      or(
        isNull(whitelabelDomains.lastCheckedAt),
        lt(whitelabelDomains.lastCheckedAt, cutoff),
      ),
    ))
    .limit(Math.max(1, Math.min(limit, 200)));

  let ready = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await verifyWhitelabelDomainTls(row.id, probe);
      if (result.status === "CERT_READY" && result.certificateStatus === "READY") ready += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { checked: rows.length, ready, failed };
}
