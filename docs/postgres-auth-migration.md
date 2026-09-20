# Existing DeployOS PostgreSQL volume: preserve data and replace network trust authentication

**Legacy bundled-database release gate — Issue #28.** Do not mark this item complete or merge a bundled-DB deployment
until the operator verifies a recoverable backup and an authenticated connection
against the ACTUAL existing database volume. The code must not delete/reinitialize
PostgreSQL data to solve an authentication problem.

The old bundled-PostgreSQL `docker-compose.yml` set `POSTGRES_HOST_AUTH_METHOD: trust`, modified
existing `pg_hba.conf` entries to `trust`, and advertised a fixed fallback
password. Merely replacing the environment variable does not fix an existing
volume: its `pg_hba.conf` and role password are persisted.

The DeployOS default `docker-compose.yml` has been restored to its original
`postgres` service, `ai-caller` Compose project and `postgres_data`
persistent volume. An existing `pg_hba.conf` is left untouched and the
old volume can continue to run until the operator backs up and migrates it.
**Compatibility does not equal an authenticated-database security close.**
For a NEW empty volume, the entrypoint refuses the historical known default
password; supply a strong `POSTGRES_PASSWORD` and matching `DATABASE_URL`.
An independently managed database must be assessed separately; do not run
this script against an unrelated managed database.

## Production migration (one coordinated maintenance window)

1. Identify the actual DeployOS deployment, its Compose project and PostgreSQL
   service/container. Confirm the current backup policy and inventory existing
   workspace/contact/conversation and billing row counts. Do **not** use
   `docker compose down -v`, `docker volume rm`, `initdb`, or a new empty
   volume to bypass this step.
2. Freeze application writes (stop web, worker and gateway but **keep the old
   PostgreSQL container running**). On the HOST, with a private directory
   (`umask 077`), make a complete consistent dump, e.g.:
   `docker exec <old-db-container> sh -c 'pg_dumpall -U "$POSTGRES_USER"' > ai-caller-db-backup.sql`.
   Preserve an independent snapshot of the named PostgreSQL volume as an
   additional rollback source. Check the dump contains the expected schema,
   store it outside the deployment and verify a restore in a disposable database.
3. Generate a distinct high-entropy password, at least 32 characters, in the
   deployment secret manager. Place it in a private single-line file and copy
   the file and `scripts/upgrade-postgres-auth.sh` into the EXISTING container.
   Restrict the secret file to the `postgres` OS user with mode 0600; do not
   paste the password in an issue, command argument, terminal screenshot, or log.
4. Execute the script inside the still-running OLD PostgreSQL container as its
   `postgres` OS user. Pass
   `AI_CALLER_POSTGRES_BACKUP_VERIFIED=YES` and
   `AI_CALLER_POSTGRES_NEW_PASSWORD_FILE=<private container path>`.
   The script checks preconditions, rotates the role using SCRAM,
   backs up pg_hba.conf, replaces network trust/md5 entries with SCRAM,
   reloads HBA and verifies an authenticated loopback TCP connection. It does
   not touch user tables or remove the volume.
5. Set `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD` and
   `DATABASE_URL` in DeployOS runtime secrets. Percent-encode any reserved
   characters in the password inside the database URL; use Docker DNS hostname
   `postgres`. The URL password MUST match the rotated database role password.
   Do not put the secrets in source control, Docker build arguments, or CI logs.
6. Deploy the restored bundled-DB Compose topology retaining the **same
   existing PostgreSQL service, Compose project and named data volume**.
   Confirm postgres healthcheck, migration job, web, worker, gateway,
   existing user data and fresh application DB connections. Confirm a valid password authenticates
   from web/worker and a missing or wrong password is rejected on the Docker
   network. Confirm no active host trust/md5 rules remain in pg_hba.conf.
7. Inspect reconciliation/recordings/credit balances and compare the saved
   pre/post counts. Only then mark Issue #28 operationally verified. Remove the
   temporary credential file from the container and private host staging area;
   retain the encrypted, access-controlled backup and HBA rollback snapshot
   according to the operator's retention policy.

## Fail-safe / rollback

The current DeployOS default retains the bundled PostgreSQL service and
existing volume; it warns rather than altering existing network trust rules.
That is a temporary backwards-compatible state, not a security approval.
Neither an authentication problem nor a failed upgrade authorizes removing
or wiping the old volume. If the upgrade fails, keep the write freeze;
restore the saved pg_hba.conf file and reload PostgreSQL while investigating.
If needed, restore the verified backup into a separate, authenticated container
with the same data and inspect it before repointing app services. Never silently
revert production to passwordless network authentication.

Fresh bundled installations (default DeployOS or manual `compose.selfhost.yaml`) must supply
credentials and create SCRAM access. Separately managed DeployOS databases
should use their provider's TLS/authenticated connection in `DATABASE_URL`.
