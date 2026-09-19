# Deploy AI Caller using Docker (cloud / V2 voice testing)

This configuration runs **PostgreSQL + one-off migrations + Next.js web + background worker** using one app image. Postgres stays on the private Compose network, and its persistent data and call recordings use named volumes. No mock AI or Telnyx providers are used by Docker Compose.

> **Existing deployment:** Your signup log showed `ECONNREFUSED 127.0.0.1:5432` from inside the web container. This Compose file specifically uses Docker DNS hostname `postgres`, not loopback. If your existing PostgreSQL already holds data, **do not point the app at a newly created empty database**; preserve and back up your existing database, and follow the “existing external DB” note below.

## Fresh self-hosted installation

On the cloud machine with Docker Engine and Docker Compose v2 installed:

```sh
git checkout feat/v2-live-voice-receptionist
cp .env.deploy.example .env.deploy
# EDIT .env.deploy BEFORE DOING ANYTHING ELSE
openssl rand -hex 24       # use this value in BOTH POSTGRES_PASSWORD and DATABASE_URL
openssl rand -hex 32       # BETTER_AUTH_SECRET
openssl rand -base64 32    # INTEGRATION_ENCRYPTION_KEY

docker compose --env-file .env.deploy config --quiet
docker compose --env-file .env.deploy up --build -d
docker compose --env-file .env.deploy ps
docker compose --env-file .env.deploy logs --tail=80 migrate web worker
```

Set these in `.env.deploy` (never commit or paste it):

- `POSTGRES_PASSWORD`: use a different **random** hex value from the auth/encryption secrets.
- `DATABASE_URL`: exact username/password/db and **`@postgres:5432`**, matching the `postgres` service defined in `compose.yaml`. If you choose a password containing URL-special characters, percent-encode its URL representation; a random hex password avoids this issue.
- `BETTER_AUTH_URL`: the public HTTPS **origin** people open in the browser (e.g. `https://ai.example.org`), not `localhost`, `web:8080`, or the private Docker IP.
- `BETTER_AUTH_SECRET` and `INTEGRATION_ENCRYPTION_KEY`: strong, stable secrets. Losing or changing the latter can prevent decrypting saved integration credentials.
- `HOSTED_AI_PROVIDER=openai`, `HOSTED_AI_MODEL=gpt-5.6-luna`, direct `HOSTED_AI_API_KEY`, `HOSTED_TELNYX_API_KEY`, and `HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY`.
- `HOSTED_WEBHOOK_BASE_URL`: leave empty if `BETTER_AUTH_URL` is public HTTPS; otherwise set it to a *separate public HTTPS app origin*. It must route to Next.js web, not to the media gateway.
- `VOICE_GATEWAY_URL`: leave unset for the **turn-based V2** call test. The media gateway only counts media frames in the current implementation; it is not a streaming agent.
- `VOICE_RECORDING_STORAGE_BACKEND=filesystem` persists recordings in a separate Docker volume. Back up both the `postgres_data` and `recordings` volumes.

**HTTPS reverse proxy:** By default Docker exposes web only on `127.0.0.1:8080` of the cloud host. Point your existing TLS reverse proxy at `http://127.0.0.1:8080` and serve your public `BETTER_AUTH_URL`. If your cloud platform handles its own ingress and needs the published port to bind all interfaces, set `AI_CALLER_BIND_ADDRESS=0.0.0.0`, and protect that port with the platform's proxy/firewall. Do not publish PostgreSQL port 5432.

**Architecture:** Compose waits for Postgres health, runs `npm run db:migrate && npm run verify:deployment` once, then starts web and worker. The app image deliberately retains `tsx` and the source/migrations because the current worker and migration scripts execute TypeScript at runtime. The `Dockerfile` uses non-secret throwaway values for `next build`; actual secrets enter only at **container runtime** via `.env.deploy`. A source-controlled dependency lockfile is not present yet, so the build uses `npm install` rather than `npm ci`; reproducibility can be improved by adding a reviewed lockfile.

## Confirm the account-creation fix

```sh
docker compose --env-file .env.deploy exec web npm run verify:deployment
curl --fail --silent http://127.0.0.1:8080/api/health
```

Expected:

```text
PASS: PostgreSQL connection established.
PASS: Signup tables and application migration history exist.
{"status":"ok","database":"ok"}
```

Then sign up through the **public HTTPS domain**, verify workspace onboarding appears, sign out and sign back in. Do not use a test password or real customer data in shared logs. If signup fails despite healthy DB, inspect redacted `web` logs for the next distinct error.

If migrations fail, the `migrate` container exits nonzero and web/worker **must not** start. Look at `docker compose --env-file .env.deploy logs migrate`, correct the DB credentials/migration error, then run `docker compose --env-file .env.deploy up --build -d` again. Never delete the Postgres volume to “fix” a migration error on an existing installation.

## Existing cloud PostgreSQL or separately managed database

The included Compose file is for a **new** private Postgres instance. To reuse an existing database, use the same `Dockerfile` with your cloud platform's web and worker services; inject `DATABASE_URL` with the real database hostname/network/TLS settings into **both**, and run a one-shot migration from that image before starting either service. Do not start the bundled `postgres` service or silently migrate an empty database instead of your current one.

Examples, adapting `YOUR_DATABASE_NETWORK` / `DATABASE_URL` to your actual infrastructure:

```sh
docker build -t ai-caller-app:local .
# In the deployment that can reach the existing database:
docker run --rm --network YOUR_DATABASE_NETWORK --env-file .env.deploy \
  ai-caller-app:local sh -ec 'npm run db:migrate && npm run verify:deployment'
```

Use the **same image and runtime env** for web (`npm start`, `PORT=8080`) and worker (`npm run worker`). Mount a persistent recording directory, and expose only the web app through HTTPS. An external managed database may not use a Docker network argument; follow your cloud provider's routing and TLS configuration. For an existing database, ensure `.env.deploy` contains its actual `DATABASE_URL`, not the bundled template's `@postgres`.

## Run V2 after signup

After account + business + AI-agent setup, use `docs/voice-v2-basic-receptionist-acceptance.md`. Confirm the server receives *real signed* Telnyx webhooks at its public domain, and purchase a managed number only after reviewing its displayed credits/carrier cost. Outbound SMS remains blocked until registration readiness is approved (Issue #24). A green Docker build proves deployment packaging, **not** a real spoken inbound call.
