#!/usr/bin/env node
/**
 * F12-D8 live acceptance. Read-only: DNS + real trusted HTTPS/SNI and,
 * optionally, the domain record in the live database. Does not modify
 * Traefik, DNS, ACME, or workspace data.
 */
import { resolve4, resolve6, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import pg from "pg";
import {
  checkWhitelabelPublicDns,
  checkWhitelabelHoldingResponse,
  checkWhitelabelHttpReachability,
} from "./whitelabel-live-verification.mjs";

const { Pool } = pg;

const hostname = process.env.WHITELABEL_TEST_HOST?.trim().toLowerCase();
const ipv4 = process.env.WHITELABEL_PUBLIC_IPV4?.trim();
const ipv6 = process.env.WHITELABEL_PUBLIC_IPV6?.trim() || null;
const expectedTxt = process.env.WHITELABEL_TEST_TXT?.trim();

if (!hostname || hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname)
  || hostname.split(".").length < 3 || isIP(hostname) !== 0
  || !ipv4 || isIP(ipv4) !== 4) {
  throw new Error("Set WHITELABEL_TEST_HOST to a public subdomain and WHITELABEL_PUBLIC_IPV4 to the edge IPv4.");
}

async function optionalRecord(work) {
  try {
    return await work();
  } catch (error) {
    if (error?.code === "ENODATA" || error?.code === "ENOTFOUND") return [];
    throw error;
  }
}

function checkHttpAtEdge() {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: ipv4,
      port: 80,
      method: "GET",
      path: "/",
      headers: {
        host: hostname,
        "user-agent": "AI-Caller-F12-D8-HTTP-Probe/1.0",
      },
      timeout: 10000,
    }, (response) => {
      response.resume();
      try {
        checkWhitelabelHttpReachability({ statusCode: response.statusCode ?? 0 });
        resolve(response.statusCode ?? 0);
      } catch (error) {
        reject(error);
      }
    });
    request.on("timeout", () => request.destroy(new Error("HTTP_PROBE_TIMEOUT")));
    request.on("error", reject);
    request.end();
  });
}

function checkHttpsAtEdge(pathname) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: ipv4,
      servername: hostname,
      port: 443,
      method: "GET",
      path: pathname,
      rejectUnauthorized: true,
      timeout: 10000,
      headers: {
        host: hostname,
        accept: "application/json",
        "user-agent": "AI-Caller-F12-D8-Live-Acceptance/1.0",
      },
    }, (response) => {
      const certificate = response.socket.getPeerCertificate();
      const mismatch = checkServerIdentity(hostname, certificate);
      if (mismatch) {
        response.resume();
        reject(new Error("TLS_CERT_INVALID: hostname is not valid for the served certificate."));
        return;
      }
      const expiresAt = new Date(certificate.valid_to ?? "");
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
        response.resume();
        reject(new Error("TLS_CERT_INVALID: certificate is absent or expired."));
        return;
      }

      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 8192) chunks.push(chunk);
        else response.destroy(new Error("TLS_ROUTE_NOT_READY: response exceeds the expected holding-page size."));
      });
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          checkWhitelabelHoldingResponse({
            statusCode: response.statusCode ?? 0, body, hostname,
          });
          resolve({ expiresAt, issuer: certificate.issuer?.O ?? "trusted issuer" });
        } catch {
          reject(new Error("TLS_ROUTE_NOT_READY: expected holding marker was not received."));
        }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("TLS_PROBE_TIMEOUT")));
    request.on("error", reject);
    request.end();
  });
}

async function verifyLiveRecord() {
  if (!process.env.DATABASE_URL) return null;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 8000, statement_timeout: 5000 });
  try {
    const result = await pool.query(
      `SELECT status, certificate_status, certificate_expires_at,
              route_provisioned_at, dns_verified_at
         FROM whitelabel_domains
        WHERE hostname = $1 AND status <> 'DISABLED'`,
      [hostname],
    );
    if (result.rowCount !== 1 || result.rows[0].status !== "CERT_READY"
      || result.rows[0].certificate_status !== "READY"
      || !result.rows[0].route_provisioned_at || !result.rows[0].dns_verified_at) {
      throw new Error("Live database record is not in verified CERT_READY state.");
    }
    return result.rows[0].certificate_expires_at;
  } finally {
    await pool.end();
  }
}

const txtName = `_ai-caller-verify.${hostname}`;
const [a, aaaa, rows] = await Promise.all([
  optionalRecord(() => resolve4(hostname)),
  optionalRecord(() => resolve6(hostname)),
  optionalRecord(() => resolveTxt(txtName)),
]);
checkWhitelabelPublicDns({
  a, aaaa, txt: rows.map((parts) => parts.join("")),
  expectedIpv4: ipv4, expectedIpv6: ipv6, expectedTxt,
});
console.log("PASS: public A/AAAA routing and purchaser TXT ownership proof.");

const httpStatus = await checkHttpAtEdge();
console.log(`PASS: public port 80 reached the configured edge (HTTP ${httpStatus}).`);

const root = await checkHttpsAtEdge("/");
const auth = await checkHttpsAtEdge("/api/auth/get-session");
console.log("PASS: trusted customer-hostname TLS and guarded HTTPS holding response.");
console.log(`Certificate expires: ${root.expiresAt.toISOString()}; issuer: ${root.issuer}.`);
if (auth.expiresAt.getTime() !== root.expiresAt.getTime()) {
  throw new Error("Unexpected TLS certificate change between holding and auth checks.");
}
const storedExpiry = await verifyLiveRecord();
console.log(storedExpiry
  ? `PASS: live DB domain is CERT_READY; recorded expiry: ${new Date(storedExpiry).toISOString()}.`
  : "NOTE: DATABASE_URL unavailable; verify CERT_READY and matching certificate expiry in live Whitelabel settings.");
console.log("Network acceptance passed. Repeat after a Traefik and DeployOS redeploy to validate persistence.");
