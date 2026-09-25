import http from "node:http";
import https from "node:https";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rawGet(pathname, host, accept = "text/html") {
  const base = new URL(baseUrl);
  const transport = base.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      hostname: base.hostname,
      port: base.port || (base.protocol === "https:" ? 443 : 80),
      method: "GET",
      path: pathname,
      headers: { host, accept },
      rejectUnauthorized: false,
    }, (response) => {
      const chunks = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

const stamp = Date.now();
const email = `f12d-host-${stamp}@example.com`;
const password = "F12dHostPass123!";
const customHost = `clients-${stamp}.example.com`;

async function grant(userId, workspaceId, code) {
  await pool.query(
    `INSERT INTO licenses
      (workspace_id, purchaser_user_id, source, external_purchase_id, product_code, status, purchased_at)
     VALUES ($1, $2, 'MANUAL', $3, $4, 'ACTIVE', now())`,
    [workspaceId, userId, `f12d-host-${code}-${stamp}`, code],
  );
}

try {
  const signup = await context.request.post(`${baseUrl}/api/auth/sign-up/email`, {
    data: { name: "F12D Host Agency", email, password },
  });
  assert(signup.ok(), `Purchaser signup failed: ${await signup.text()}`);

  const owner = await pool.query(
    `SELECT u.id AS user_id, m.workspace_id
       FROM "user" u
       JOIN memberships m ON m.user_id = u.id
      WHERE u.email = $1 AND m.role = 'OWNER'`,
    [email],
  );
  assert(owner.rowCount === 1, "Expected purchaser original workspace.");
  const { user_id: userId, workspace_id: workspaceId } = owner.rows[0];
  await grant(userId, workspaceId, "CORE");
  await grant(userId, workspaceId, "AGENCY_50");
  await grant(userId, workspaceId, "WHITELABEL");

  const claim = await context.request.post(`${baseUrl}/api/whitelabel/domain`, {
    data: { hostname: customHost },
  });
  assert(claim.status() === 201, `Domain claim failed: ${await claim.text()}`);
  const domain = (await claim.json()).domain;

  await pool.query(
    `UPDATE whitelabel_domains
        SET status = 'CERT_PENDING',
            a_verified_at = now(),
            txt_verified_at = now(),
            dns_verified_at = now(),
            route_id = $2,
            route_provisioned_at = now(),
            certificate_status = 'PENDING',
            updated_at = now()
      WHERE id = $1`,
    [domain.id, `wl-${domain.id.replaceAll("-", "")}`],
  );

  const holding = await rawGet("/dashboard", customHost);
  assert(holding.status === 200, `Expected holding page 200, got ${holding.status}: ${holding.body}`);
  assert(holding.body.includes("Your client platform is being configured."),
    "Custom host did not reach the neutral holding page.");
  assert(!holding.body.includes("AI Caller"),
    "Custom host leaked canonical AI Caller branding.");

  const authSurface = await rawGet("/api/auth/get-session", customHost, "application/json");
  assert(authSurface.status === 200, `Expected guarded auth path to return holding response, got ${authSurface.status}`);
  assert(authSurface.body.includes('"status":"domain-ready"'),
    "Custom host reached the canonical auth route instead of the holding route.");

  const unknown = await rawGet("/dashboard", `unknown-${stamp}.example.com`);
  assert(unknown.status === 404, `Unknown host should fail closed with 404, got ${unknown.status}`);
  assert(!unknown.body.includes("AI Caller"), "Unknown host exposed canonical AI Caller UI.");

  const canonicalHealth = await rawGet("/api/health", new URL(baseUrl).host, "application/json");
  assert(canonicalHealth.status === 200, "Canonical/loopback health route was blocked by host guard.");
  assert(!canonicalHealth.body.includes("Your client platform is being configured."),
    "Canonical host was incorrectly rewritten to Whitelabel holding.");

  await pool.query(
    `UPDATE licenses SET status = 'REFUNDED'
      WHERE purchaser_user_id = $1 AND product_code = 'WHITELABEL'`,
    [userId],
  );
  const revoked = await rawGet("/dashboard", customHost);
  assert(revoked.status === 404,
    `Refunded Whitelabel host should fail closed before route cleanup, got ${revoked.status}`);

  console.log("F12-D host guard acceptance passed: canonical traffic preserved, custom host held, auth surface blocked, unknown host rejected, and refunded Whitelabel fails closed immediately.");
} finally {
  await browser.close();
  await pool.end();
}
