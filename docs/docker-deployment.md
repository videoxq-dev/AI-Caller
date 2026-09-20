# Deploy AI Caller using Docker — DeployOS or self-hosted Compose

## DeployOS: preserve the EXISTING bundled PostgreSQL service and data

The default `docker-compose.yml` is the original working DeployOS **bundled**
PostgreSQL topology plus `migrate`, `web`, `worker`, and the Realtime `gateway`.
It retains the Compose project name `ai-caller`, PostgreSQL service hostname
`postgres`, and persistent `postgres_data` volume. Docker automatically
initializes PostgreSQL **only when that same volume is empty**. An existing
volume is NOT recreated, replaced, or wiped by the application deploy.

**Existing AI Caller deployments:** keep your currently working `DATABASE_URL`
with hostname `postgres`, and keep all existing account, encryption, Telnyx,
Stripe and recording settings. You do NOT need to add `POSTGRES_USER`,
`POSTGRES_DB` or `POSTGRES_PASSWORD` just to pass `docker compose config`
if the original database already exists and uses the historical defaults.
The legacy role/database defaults remain `postgres`/`ai_caller`.

**New empty database volumes:** the default does not silently initialize
PostgreSQL with the previous known fallback password or network `trust`.
Before provisioning a new installation, set `POSTGRES_PASSWORD` to a strong
random secret, and a matching URL-safe password in `DATABASE_URL` (with
hostname `postgres`); optionally set `POSTGRES_USER` and `POSTGRES_DB`.
New volumes use SCRAM authentication. This still auto-creates the database
from an empty volume, but only after secure credentials are configured.

**Existing legacy `trust` authentication is not automatically migrated:**
the service warns when the current volume has old permissive host rules
and continues serving the existing data. Never change or reset a live
PostgreSQL password or HBA file without a recoverable backup and the
controlled migration in `docs/postgres-auth-migration.md` (Issue #28).
This compatibility fix is NOT security signoff for an old trust-auth volume.

Select branch `feat/dual-voice-realtime`, use Compose service **web** as
DeployOS's public app on internal port 8080 (`/api/health`), and retain
the existing `.env`/DeployOS secret values. The `gateway` is a private
service on port 3002; route a separate TLS-terminated `wss://` endpoint
to it only when testing Realtime. Leave `VOICE_REALTIME_ENABLED=false`
until live acceptance (Issue #31).

Before deploying, verify the app's actual Compose project and volume names.
If a previous DeployOS installation used a different project name, stop:
restore the same project name or use an explicit, verified external volume
name. Do not allow Docker to create a fresh `postgres_data` volume for an
already-used database. Do not run `docker compose down -v`, `docker volume rm`,
or `initdb` to troubleshoot an existing installation.

See the `migrate` service log for database connectivity or migration errors.
The migration job runs before web, worker and gateway. A Compose-config
parsing error occurs before any of these services start.

### If DATABASE_URL references an independently managed database

The default DeployOS Compose is not external-DB-only. It will still start
its bundled PostgreSQL service. An independently managed database requires
a separate explicitly chosen deployment topology. Do not silently switch
an existing bundled install to an unrelated database or vice versa.

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
