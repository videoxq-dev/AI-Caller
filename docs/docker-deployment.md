# Deploy AI Caller using Docker — DeployOS or self-hosted Compose

## DeployOS: use your EXISTING PostgreSQL database (recommended if you already configured DeployOS)

The default `docker-compose.yml` runs **web + migration job + worker + Realtime gateway** using the repository `Dockerfile`. It does **not** provision another PostgreSQL container or require `POSTGRES_USER`, `POSTGRES_PASSWORD`, or `POSTGRES_DB` for `docker compose config`. DeployOS writes your configured environment variables into a server-side `.env` at deploy time. The Compose file reads that file optionally and passes its values to all three application services. Never put keys in Git. See DeployOS's Config → Environment Variables & Secrets.

**Fix for the original deployment error:** PR #27 previously had a bundled PostgreSQL service and required `${POSTGRES_USER:?}`, `${POSTGRES_PASSWORD:?}`, `${POSTGRES_DB:?}` during Compose interpolation. That was inappropriate for an existing DeployOS database and made Compose fail before any container started. The current default `docker-compose.yml` has no such interpolation.

1. In DeployOS, select repository `videoxq-dev/AI-Caller`, branch `feat/dual-voice-realtime`, build method **Dockerfile (repo compose)**. Use **web** as app service, internal port **8080**, and health path `/api/health`. DeployOS terminates HTTPS and connects the app to its edge proxy. Do not select the `migrate` or `worker` service as the public app.
2. Confirm your existing PostgreSQL database is actually running. If DeployOS manages it, open **Databases**, find your PostgreSQL instance, and use its actual connection string (do not paste it into a GitHub issue or chat). `DATABASE_URL` needs a hostname resolvable and reachable **inside the web, worker, and migration containers**. `127.0.0.1`/`localhost` in this URL is almost certainly wrong for a separately deployed Docker database.
3. In DeployOS app **Config → Environment Variables**, set `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `HOSTED_AI_PROVIDER=openai`, `HOSTED_AI_MODEL=gpt-5.6-luna`, your direct `HOSTED_AI_API_KEY`, your Telnyx global key and webhook public key. `BETTER_AUTH_URL` is the **public HTTPS origin** people visit, not `web:8080`. For V2 use `HOSTED_WEBHOOK_BASE_URL` only if it differs from that public HTTPS origin; leave `VOICE_GATEWAY_URL` blank for the turn-based call acceptance. Retain your other configured plan, payment and SMTP variables as needed.
4. Deploy the updated branch. The `migrate` job applies SQL migrations and checks database readiness; `web` and `worker` start only after it succeeds. If the DB is missing, unreachable, misconfigured or has migration errors, expect a **clear deployment error** rather than a signup form with broken persistence.
5. Visit your public `https://YOUR-APP-DOMAIN/api/health`: it must return HTTP 200 with `{"status":"ok","database":"ok"}`. Then sign up, open your workspace onboarding, sign out and sign back in. These are the live acceptance criteria for the cloud signup fix.

If DeployOS reports `ECONNREFUSED 127.0.0.1:5432` **after** it can read the Compose file, that is a **different, runtime error**: the actual `DATABASE_URL` still targets container loopback. Correct it to the reachable DeployOS-managed or external PostgreSQL hostname. Check whether the DB and app are attached to compatible Docker networks; there is no universal service hostname.

**Important:** An existing `DATABASE_URL` alone does not set `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`, and a runtime container environment is different from Compose file interpolation. This is why the previous default Compose failed even though your app variables were configured.

## DeployOS deployment on `feat/dual-voice-realtime`

The default `docker-compose.yml` now **only** runs `migrate`, `web`,
`worker`, and the separate `gateway` against the app's **existing
authenticated `DATABASE_URL`**. It must not demand `POSTGRES_USER`,
`POSTGRES_DB` or `POSTGRES_PASSWORD` from an app that has its own
DeployOS-managed database. The bundled database remains **opt-in** via
`compose.selfhost.yaml`, and that file is for a new manual all-in-one
installation, not an automatic replacement for an existing database.

If DeployOS says `POSTGRES_DB` or `POSTGRES_PASSWORD` is required before
it starts containers, inspect the selected branch/Compose path: it is the
superseded default (prior to the external-DB fix). Set the existing app's
`DATABASE_URL` in DeployOS Config and redeploy the corrected branch. **Do
not** make up PostgreSQL credentials, reinitialize the database, switch
`DATABASE_URL` to localhost or delete a volume to satisfy interpolation.

**Existing bundled-Postgres caveat:** earlier `docker-compose.yml` revisions
*did* start a `postgres` service. Before changing the service graph on such
a deployment, privately inspect the DATABASE_URL host and Docker volume/
container names. If it points to the old Compose service `postgres`, do not
switch that deployment to the external-DB default until a recoverable backup
and authenticated migration are verified under
`docs/postgres-auth-migration.md`; keep the old database available.
Switching Compose files must never silently replace the original
`ai-caller_postgres_data` volume with a new empty database.

For Realtime, separately route a TLS-terminated public `wss://` endpoint to
the `gateway` internal port 3002 and set `VOICE_GATEWAY_URL` in the
application's DeployOS secrets. Leave `VOICE_REALTIME_ENABLED=false`
until live carrier/model acceptance and credit reconciliation (Issue #31).

## DeployOS reports DATABASE_URL missing or invalid after an ENOTFOUND error

The migration log `FAIL: DATABASE_URL is missing or is not a valid PostgreSQL connection URL` means **there is no usable URL in that particular container**. It does not establish a database networking or password failure. A previous `ENOTFOUND ai-caller-postgres-1` error proves a URL existed in the *previous* deployment, but not that the redeployed container is receiving the same variable.

In DeployOS, verify the variable **key is exactly `DATABASE_URL`** on the **AI Caller app's Config → Environment Variables** (not solely the database app). Check whether a blank per-app variable is overriding a populated global secret. Use DeployOS's actual PostgreSQL connection URL, with correct private network hostname; do not add placeholder values, whitespace or a copied `DATABASE_URL=` prefix inside the value input. Save the config and trigger a new deployment to apply it.

All four services (`migrate`, `web`, `worker`, and `gateway`) share the optional server-side `.env` specified by `docker-compose.yml`. If DeployOS puts variables in a different location or injects them only into a selected web service, the migration job won't inherit them. Verify your DeployOS environment-file generation for this Compose deployment and ensure **each** service receives the same variable.

From the app's Compose directory, validate the effective container environment **without printing secrets**:

```sh
docker compose run --rm --no-deps migrate npm run verify:database-connection
```

The revised check explicitly distinguishes `DATABASE_URL is missing or empty in this container` from `DATABASE_URL is present but not a valid PostgreSQL URL`; a syntactically valid but unresolvable URL instead reports the **hostname** plus `ENOTFOUND`. Do not publish your full database connection string or `docker compose config` output in support threads because they may contain passwords.

## DeployOS migration failed with exit 1

An exit code from `migrate` is a **summary**, not the error cause. Open the DeployOS deployment's `migrate` service log (or from its app Compose directory run `docker compose logs --tail=100 migrate`) and find the FIRST `FAIL:` line or PostgreSQL error immediately before the container exits. Do not use the blank web log as evidence: the web container has not started yet.

The migration job now runs `npm run verify:database-connection` **before** SQL migrations. It prints the resolved database hostname/port, a sanitized `PASS` or `FAIL`, and the error code (for example `ENOTFOUND`, `ECONNREFUSED`, `28P01`, or `3D000`). When diagnosing an earlier deployed revision, run the probe manually from a disposable container using the existing DeployOS configuration:

```sh
docker compose run --rm --no-deps migrate npm run verify:database-connection
```

Run this in the app Compose directory; never paste `DATABASE_URL` or `docker compose config` with secrets into a support message.

- **`ENOTFOUND` or `EAI_AGAIN`** for a name like `ai-caller-postgres-1`: the name is not resolvable from the app container. DeployOS may create the database and application in **separate Compose projects and Docker networks**. A container's displayed name is not proof that it can resolve across networks. Compare network **names only** using `docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' ai-caller-postgres-1` and the corresponding app migration container. Use DeployOS's actual application-reachable DB hostname, or attach the app's web, worker, and migration services and the DB to the same appropriately scoped private Docker network. Do not publish PostgreSQL to the Internet just to solve DNS.
- **`ECONNREFUSED`**: the name resolved but port 5432 refused the connection. Confirm the database is healthy, listens on its container network interface, and the host/port target is correct.
- **`28P01`/`28000`**: use the credentials and database name shown on the database's DeployOS card; `user` and `password` are often **placeholders**, not actual database credentials. URL-encode special characters in a connection-string password.
- **`3D000`**: the requested database does not exist; select an existing DB or create it intentionally.
- **Connection PASS, then migration SQL error**: keep the FIRST migration error and its file name; back up an existing database before schema repair. Do not delete volumes or replace a used DB with an empty one.

DeployOS documents that standalone databases run alongside apps and should have their actual connection strings added to the app. Separate Compose project networks are isolated unless deliberately connected. See `docs/cloud-deployment-signup-database.md` for the signup acceptance gate.

## Manual all-in-one VPS deployment: create a NEW private PostgreSQL database

Use **`compose.selfhost.yaml`**, not the DeployOS default `compose.yaml`. This optional file starts private PostgreSQL 16, performs migrations, starts web and worker, and persists the database and recordings in named volumes.

**Never switch an existing app with real data to a fresh bundled database unless deliberately migrating and restoring that data.** Back up your current database first.

```bash
git checkout feat/dual-voice-realtime
cp .env.deploy.example .env.deploy
# Edit .env.deploy: replace every CHANGE_ME value and set your actual public HTTPS URL.
# Generate separate secrets:
openssl rand -hex 24      # use as BOTH POSTGRES_PASSWORD and password in DATABASE_URL
openssl rand -hex 32      # BETTER_AUTH_SECRET
openssl rand -base64 32   # INTEGRATION_ENCRYPTION_KEY

docker compose --env-file .env.deploy -f compose.selfhost.yaml config --quiet
docker compose --env-file .env.deploy -f compose.selfhost.yaml up --build -d
docker compose --env-file .env.deploy -f compose.selfhost.yaml ps
docker compose --env-file .env.deploy -f compose.selfhost.yaml exec web npm run verify:deployment
```

The sample for **this bundled Postgres only** is `DATABASE_URL=postgresql://ai_caller:<matching-URL-safe-password>@postgres:5432/ai_caller`. It is deliberately **not** a universal DeployOS database URL.

The self-hosted configuration binds web to host loopback port 8080 by default; put your TLS reverse proxy in front of `http://127.0.0.1:8080`. Keep Postgres port 5432 private. The app image retains `tsx` because the worker and migration commands currently run TypeScript directly. Database and recordings must both be included in backups.

## Verify an already deployed container

When the deployment is up, enter the **web** container using DeployOS Console (or equivalent) and run:

```bash
npm run verify:deployment
```

Expected:

```text
PASS: PostgreSQL connection established.
PASS: Signup tables and application migration history exist.
```

The probe prints only the database hostname/port and sanitized outcomes, not credentials. Never paste `.env` or connection strings into support threads.

## V2 voice acceptance

When signup and onboarding work, proceed with `docs/voice-v2-basic-receptionist-acceptance.md`. Managed-number purchase is a separate, explicitly authorized action that may incur carrier fees; approved US messaging registration remains independent of the inbound voice test.
