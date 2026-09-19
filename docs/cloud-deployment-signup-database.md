# Cloud deployment: unblock account creation and the V2 voice test

## Incident: 2026-09-19

**Observed:** the Next.js web container starts and returns a signup form, but Better Auth's first user lookup fails with `ECONNREFUSED 127.0.0.1:5432`. That is a PostgreSQL connectivity error, not an invalid user, wrong email, OpenAI issue, or Telnyx issue. The first query cannot reach the database; retrying signup without fixing connectivity will repeat the failure.

**Cause supported by the logs:** the web process tries TCP port 5432 on its **own container loopback**. In an ordinary Docker Compose bridge network, `localhost`/`127.0.0.1` refers to `ai-caller-web-1`, not the Postgres container or the VM's host. The log does not establish which database container/service or external database you have; use the actual deployment topology, not an assumed name.

**Immediate operator fix (requires updating your cloud deployment, not buying a number):**

1. Locate the real PostgreSQL service or managed DB, confirm it is started and healthy, and determine its hostname **as resolvable from the web container**. Common Compose service names are `postgres` or `db`, but use yours. Ensure the web, worker and database share the necessary Docker network. For managed Postgres, use its provided DNS, port and TLS requirements.
2. Change **the cloud web and worker runtime** `DATABASE_URL` to the actual database hostname, e.g. `postgresql://APP_USER:URL_ENCODED_PASSWORD@postgres:5432/ai_caller` **only if** the Compose database service is actually named `postgres`. Do not use `127.0.0.1` or `localhost` for a separate DB container. Do not publish Postgres publicly to solve this.
3. Make `BETTER_AUTH_URL` the **external HTTPS origin** users visit, e.g. `https://app.YOUR-DOMAIN` (no internal container address or port). Set `HOSTED_WEBHOOK_BASE_URL` to the same public origin or omit it when `BETTER_AUTH_URL` is already public HTTPS. Your app may correctly listen internally on port 8080 behind the proxy; that does not change the external auth URL.
4. Restart/redeploy web and worker to load the new runtime environment. Setting variables in a local `.env` does not necessarily change an existing container; the hosting platform's environment injection and image build may override local files.
5. From the **new web container**, run `npm run verify:deployment`. It must report **PostgreSQL connection established** and **Signup tables and application migration history exist**. The command prints hostname, port, sanitized error code and actionable hint; never the full connection string or password.
6. If the connection passes but the schema check fails, run `npm run db:migrate` against the same database **using an image/source checkout that includes the migration files and `tsx`**. The production web image may omit dev dependencies; use the normal migration job or a one-off build with the tooling. Re-run `npm run verify:deployment`.
7. Request the app's public `/api/health`; expect HTTP 200 with `{"status":"ok","database":"ok"}`. HTTP 503 means the database is still inaccessible from the web app. Then create an account through the signup page and confirm your workspace/onboarding page loads.

For Docker Compose, the checks usually look like:

```bash
docker compose ps
docker compose logs --tail=80 postgres   # Replace postgres with YOUR actual DB service name.
docker compose exec web npm run verify:deployment
# If needed, execute migration tooling from your application source/build image:
docker compose exec web npm run db:migrate
docker compose exec web npm run verify:deployment
```

The `docker compose exec` examples assume service names `web`/`postgres` and that the web image includes npm scripts and migration tooling. Substitute the real Compose service names. For a managed Postgres database, there may be **no** Compose database service to inspect.

### What working means: Signup recovery (V2 prerequisite)

- Deployment check reports the DB target hostname you intended, a live PostgreSQL connection, and existing signup/workspace tables plus migration history.
- Public `/api/health` returns 200 (not just Next.js's “Ready” startup message).
- A new test user signs up, receives a session, and can enter onboarding without `ECONNREFUSED` or missing-table errors.
- A subsequent sign-in with that user works. No user PII, database password or full `DATABASE_URL` appears in shared diagnostics.
- Then return to `docs/voice-v2-basic-receptionist-acceptance.md` for managed-number provisioning and a real inbound call.

### Safe diagnostic feedback

```text
Commit/deployment version:
Actual DB topology: same Compose stack / external Compose stack / managed PostgreSQL
Web DB target hostname only (no username, password, database URL):
Web and DB on shared network: yes / no / external DB
npm run verify:deployment: PASS / FAIL with sanitized output
Migration job: PASS / FAIL / not yet run
Public GET /api/health: 200 / 503 / other
Create account: PASS / FAIL
Sign in: PASS / FAIL
Next issue (redacted logs without email or secrets):
```

**Important:** A green CI run against CI's Postgres service does not prove your cloud's `DATABASE_URL` is configured correctly. Likewise, a successful V1 live OpenAI/Telnyx probe does not test PostgreSQL or production signup.
