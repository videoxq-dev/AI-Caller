import test from "node:test";
import assert from "node:assert/strict";
import { connectionTarget, databaseHint, verifyDeploymentDatabase } from "./verify-deployment-db.mjs";

test("recognizes container loopback vs Docker service name without exposing credentials", () => {
  assert.deepEqual(connectionTarget("postgresql://user:pass@127.0.0.1:5432/ai_caller"), {
    valid: true, loopback: true, host: "127.0.0.1", port: "5432",
  });
  assert.equal(connectionTarget("postgresql://u:p@localhost/database").loopback, true);
  assert.equal(connectionTarget("postgresql://u:p@[::1]:5432/db").loopback, true);
  assert.equal(connectionTarget("postgresql://u:p@postgres:5432/db").loopback, false);
  assert.equal(connectionTarget("postgresql://u:p@db.internal:5432/db").loopback, false);
  assert.equal(connectionTarget("not-a-url").valid, false);
});

test("connection refusal points to Docker DNS and no secrets", () => {
  const message = databaseHint("ECONNREFUSED", connectionTarget("postgres://owner:top-secret@localhost:5432/ai"));
  assert.match(message, /Docker Compose/);
  assert.match(message, /postgres:5432/);
  assert.doesNotMatch(message, /owner|top-secret/);
});

test("missing connection does not instantiate a client", async () => {
  const logs = [];
  const ok = await verifyDeploymentDatabase({
    env: {}, ClientCtor: class { constructor() { throw new Error("unexpected"); } },
    log: (msg) => logs.push(msg),
  });
  assert.equal(ok, false);
  assert.match(logs.join("\n"), /DATABASE_URL is missing or empty/);
});

test("refused Docker loopback is reported without a credential or error body", async () => {
  const logs = [];
  const ok = await verifyDeploymentDatabase({
    env: { DATABASE_URL: "postgres://owner:top-secret@127.0.0.1:5432/ai_caller" },
    ClientCtor: class {
      async connect() { const error = new Error("top-secret"); error.code = "ECONNREFUSED"; throw error; }
      async end() {}
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(ok, false);
  assert.match(logs.join("\n"), /ECONNREFUSED/);
  assert.match(logs.join("\n"), /postgres:5432/);
  assert.doesNotMatch(logs.join("\n"), /top-secret|owner/);
});

test("connected database missing migrations is not called signup-ready", async () => {
  const logs = [];
  const ok = await verifyDeploymentDatabase({
    env: { DATABASE_URL: "postgres://u:p@postgres:5432/ai_caller" },
    ClientCtor: class {
      async connect() {}
      async query() { return { rows: [{ user_table: "user", workspaces_table: "workspaces", migrations_table: null }] }; }
      async end() {}
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(ok, false);
  assert.match(logs.join("\n"), /npm run db:migrate/);
});

test("connected and migrated database is signup-ready", async () => {
  const logs = [];
  let calls = 0;
  const ok = await verifyDeploymentDatabase({
    env: { DATABASE_URL: "postgres://u:p@postgres:5432/ai_caller" },
    ClientCtor: class {
      async connect() {}
      async query() {
        calls += 1;
        return calls === 1
          ? { rows: [{ user_table: "user", workspaces_table: "workspaces", migrations_table: "app_migrations" }] }
          : { rows: [{ count: 19 }] };
      }
      async end() {}
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(ok, true);
  assert.match(logs.join("\n"), /Signup tables and application migration history exist/);
});


test("connection-only preflight succeeds before migrations exist", async () => {
  const logs = [];
  let queried = false;
  const ok = await verifyDeploymentDatabase({
    env: { DATABASE_URL: "postgres://u:p@ai-caller-postgres-1:5432/ai_caller" },
    connectOnly: true,
    ClientCtor: class {
      async connect() {}
      async query() { queried = true; throw new Error("migrations not applied"); }
      async end() {}
    },
    log: (message) => logs.push(message),
  });
  assert.equal(ok, true);
  assert.equal(queried, false);
  assert.match(logs.join("\n"), /PASS: PostgreSQL connection established/);
  assert.doesNotMatch(logs.join("\n"), /u:p/);
});

test("connection-only preflight identifies DNS isolation without disclosing connection string", async () => {
  const logs = [];
  const ok = await verifyDeploymentDatabase({
    env: { DATABASE_URL: "postgres://some-user:secret@ai-caller-postgres-1:5432/ai_caller" },
    connectOnly: true,
    ClientCtor: class {
      async connect() {
        const error = new Error("postgres://some-user:secret@ai-caller-postgres-1:5432/ai_caller");
        error.code = "ENOTFOUND";
        throw error;
      }
      async end() {}
    },
    log: (message) => logs.push(message),
  });
  assert.equal(ok, false);
  assert.match(logs.join("\n"), /ENOTFOUND/);
  assert.match(logs.join("\n"), /Docker service name/);
  assert.doesNotMatch(logs.join("\n"), /some-user|secret/);
});

test("malformed URL is distinct from missing injection and does not log supplied value", async () => {
  const logs = [];
  const malformed = "not a url with super-secret-value";
  const ok = await verifyDeploymentDatabase({
    env: { DATABASE_URL: malformed },
    ClientCtor: class { constructor() { throw new Error("should not connect"); } },
    log: (message) => logs.push(message),
  });
  assert.equal(ok, false);
  assert.match(logs.join("\n"), /present but not a valid PostgreSQL URL/);
  assert.doesNotMatch(logs.join("\n"), /super-secret-value/);
});

test("an empty injected database URL is reported as missing", async () => {
  const logs = [];
  const ok = await verifyDeploymentDatabase({
    env: { DATABASE_URL: " " },
    ClientCtor: class { constructor() { throw new Error("should not connect"); } },
    log: (message) => logs.push(message),
  });
  assert.equal(ok, false);
  assert.match(logs.join("\n"), /missing or empty in this container/);
});
