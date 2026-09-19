#!/usr/bin/env node
// Safe deployment diagnostic for signup and other database-backed operations.
// Never print DATABASE_URL, credentials, SQL parameters, or raw provider errors.
import { config } from "dotenv";
import pg from "pg";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Mirror Next.js runtime precedence when a hosting platform uses env files instead
// of injected container variables; dotenv never overrides existing shell variables.
const mode = process.env.NODE_ENV === "production" ? "production" : "development";
for (const file of [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"]) {
  config({ path: file });
}

export function connectionTarget(value) {
  if (!value?.trim()) return { valid: false, loopback: false, host: "unknown", port: "5432" };
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("not PostgreSQL");
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = host === "localhost" || host === "::1"
      || /^127(?:\.\d{1,3}){3}$/.test(host);
    return { valid: true, loopback, host, port: url.port || "5432" };
  } catch {
    return { valid: false, loopback: false, host: "unknown", port: "5432" };
  }
}

export function databaseHint(code, target) {
  if (code === "ECONNREFUSED") {
    return target.loopback
      ? "Nothing accepts PostgreSQL connections at this container's loopback address. In Docker Compose use the PostgreSQL service name (for example postgres:5432) on a shared network, not localhost/127.0.0.1."
      : "PostgreSQL refused the connection. Check service health, network, database port, and firewall.";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Database hostname cannot resolve; check the Docker service name, shared network, or external database DNS.";
  if (code === "28P01" || code === "28000") return "Database authentication failed; check user, password, and pg_hba rules.";
  if (code === "3D000") return "The named database does not exist; create it or correct DATABASE_URL.";
  if (code === "ETIMEDOUT" || code === "ETIMEOUT") return "Database timed out; check networking, firewall, provider access and database health.";
  if (typeof code === "string" && code.startsWith("08")) return "Database connection failed; check reachability and server TLS requirements.";
  return "Check the PostgreSQL service, DATABASE_URL, networking, TLS configuration, and database migrations.";
}

export async function verifyDeploymentDatabase({
  env = process.env,
  ClientCtor = pg.Client,
  log = console.log,
} = {}) {
  const target = connectionTarget(env.DATABASE_URL);
  if (!target.valid) {
    log("FAIL: DATABASE_URL is missing or is not a valid PostgreSQL connection URL.");
    return false;
  }

  // Reporting only the hostname and port avoids disclosing URL credentials.
  log(`Database target: ${target.host}:${target.port}`);
  const client = new ClientCtor({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  try {
    await client.connect();
    log("PASS: PostgreSQL connection established.");
    const { rows } = await client.query(
      'SELECT to_regclass(\'public."user"\') AS user_table, to_regclass(\'public.workspaces\') AS workspaces_table, to_regclass(\'public.app_migrations\') AS migrations_table',
    );
    const state = rows[0];
    if (!state?.user_table || !state?.workspaces_table || !state?.migrations_table) {
      log("FAIL: Account/workspace schema or migration history is missing. Run npm run db:migrate against this database before allowing signups.");
      return false;
    }
    const migrationResult = await client.query("SELECT COUNT(*)::int AS count FROM app_migrations");
    if (!migrationResult.rows[0]?.count) {
      log("FAIL: No application migrations are recorded. Run npm run db:migrate against this database.");
      return false;
    }
    log("PASS: Signup tables and application migration history exist.");
    return true;
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "DATABASE_UNAVAILABLE";
    log(`FAIL: PostgreSQL ${code}. ${databaseHint(code, target)}`);
    return false;
  } finally {
    try { await client.end(); } catch { /* Never log connection strings or driver internals. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyDeploymentDatabase().then((ok) => {
    if (!ok) process.exitCode = 1;
  }).catch(() => {
    console.error("FAIL: Deployment database probe could not complete.");
    process.exitCode = 1;
  });
}
