# Deploy AI Caller using Docker — DeployOS or self-hosted Compose

## DeployOS: use your EXISTING PostgreSQL database (recommended if you already configured DeployOS)

The default `docker-compose.yml` runs **web + migration job + worker** using the repository `Dockerfile`. It does **not** provision another PostgreSQL container or require `POSTGRES_USER`, `POSTGRES_PASSWORD`, or `POSTGRES_DB` for `docker compose config`. DeployOS writes your configured environment variables into a server-side `.env` at deploy time. The Compose file reads that file optionally and passes its values to all three application services. Never put keys in Git. See DeployOS's Config → Environment Variables & Secrets.

**Fix for the original deployment error:** PR #27 previously had a bundled PostgreSQL service and required `${POSTGRES_USER:?}`, `${POSTGRES_PASSWORD:?}`, `${POSTGRES_DB:?}` during Compose interpolation. That was inappropriate for an existing DeployOS database and made Compose fail before any container started. The corrected default `compose.yaml` has no such interpolation.

1. In DeployOS, select repository `videoxq-dev/AI-Caller`, branch `feat/v2-live-voice-receptionist`, build method **Dockerfile (repo compose)**. Use **web** as app service, internal port **8080**, and health path `/api/health`. DeployOS terminates HTTPS and connects the app to its edge proxy. Do not select the `migrate` or `worker` service as the public app.
2. Confirm your existing PostgreSQL database is actually running. If DeployOS manages it, open **Databases**, find your PostgreSQL instance, and use its actual connection string (do not paste it into a GitHub issue or chat). `DATABASE_URL` needs a hostname resolvable and reachable **inside the web, worker, and migration containers**. `127.0.0.1`/`localhost` in this URL is almost certainly wrong for a separately deployed Docker database.
3. In DeployOS app **Config → Environment Variables**, set `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `HOSTED_AI_PROVIDER=openai`, `HOSTED_AI_MODEL=gpt-5.6-luna`, your direct `HOSTED_AI_API_KEY`, your Telnyx global key and webhook public key. `BETTER_AUTH_URL` is the **public HTTPS origin** people visit, not `web:8080`. For V2 use `HOSTED_WEBHOOK_BASE_URL` only if it differs from that public HTTPS origin; leave `VOICE_GATEWAY_URL` blank for the turn-based call acceptance. Retain your other configured plan, payment and SMTP variables as needed.
4. Deploy the updated branch. The `migrate` job applies SQL migrations and checks database readiness; `web` and `worker` start only after it succeeds. If the DB is missing, unreachable, misconfigured or has migration errors, expect a **clear deployment error** rather than a signup form with broken persistence.
5. Visit your public `https://YOUR-APP-DOMAIN/api/health`: it must return HTTP 200 with `{"status":"ok","database":"ok"}`. Then sign up, open your workspace onboarding, sign out and sign back in. These are the live acceptance criteria for the cloud signup fix.

If DeployOS reports `ECONNREFUSED 127.0.0.1:5432` **after** it can read the Compose file, that is a **different, runtime error**: the actual `DATABASE_URL` still targets container loopback. Correct it to the reachable DeployOS-managed or external PostgreSQL hostname. Check whether the DB and app are attached to compatible Docker networks; there is no universal service hostname.

**Important:** An existing `DATABASE_URL` alone does not set `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`, and a runtime container environment is different from Compose file interpolation. This is why the previous default Compose failed even though your app variables were configured.

## Manual all-in-one VPS deployment: create a NEW private PostgreSQL database

Use **`compose.selfhost.yaml`**, not the DeployOS default `compose.yaml`. This optional file starts private PostgreSQL 16, performs migrations, starts web and worker, and persists the database and recordings in named volumes.

**Never switch an existing app with real data to a fresh bundled database unless deliberately migrating and restoring that data.** Back up your current database first.

```bash
git checkout feat/v2-live-voice-receptionist
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
