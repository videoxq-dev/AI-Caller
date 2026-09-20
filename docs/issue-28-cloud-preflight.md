# Cloud database inventory before the existing-volume SCRAM cutover

Issue #28 remains open until the **actual** production-like DeployOS database
is verified, not merely the disposable CI fixture. This preflight makes no
changes to containers, credentials, volumes, or application records.

On the **current Docker host**, use a copy of this repository's
`scripts/inspect-deployos-postgres.sh` and run:

```sh
sh scripts/inspect-deployos-postgres.sh
```

The script selects the *running* container bearing both Compose labels
`com.docker.compose.project=ai-caller` and
`com.docker.compose.service=postgres`. If there is not exactly one match,
first identify the real database, then set
`AI_CALLER_DB_CONTAINER=<existing-container-name-or-ID>` and rerun. An
explicit selection is still rejected if its Compose labels do not match.
Do not guess based on a familiar-looking hostname, start a new Compose
project, or run `docker compose down -v`.

The result contains only:

- The Compose project, DB container, named volume and whether host TCP
  port 5432 is published.
- PostgreSQL version, whether the login role stores a SCRAM password,
  parsed HBA errors and non-SCRAM **host** rule count.
- Aggregate counts for workspaces, contacts, conversations, messages,
  appointments, wallets and ledger entries, plus aggregated wallet balances
  and ledger amounts (in existing AI Caller credits).

It does **not** print the DB password, hash, HBA CIDRs, `DATABASE_URL`,
customer records or provider credentials. It uses one consistent PostgreSQL repeatable-read, read-only
transaction and a 15-second SQL statement timeout so large-table scans fail
rather than run without a time bound. It never invokes a migration, backup,
or restart. If the PostgreSQL local Unix-socket login or any expected table is unavailable,
the script fails: investigate rather than interpreting missing output as zero.

Capture the sanitized output in the private operational change record. Do
not post user data, secrets, database dumps or full Docker environment
output to GitHub. Before performing any mutation, identify the real
DeployOS secret source and confirm the app, worker, gateway, and migration
service use the *same* intended DB. These services must not be switched to
a new/empty volume while correcting authentication.

Next follow [postgres-auth-migration.md](postgres-auth-migration.md):
freeze writes while retaining the DB container, back up the exact volume,
**restore-test** the backup in isolation, rotate the existing role and HBA,
deploy matching secrets, verify authenticated network connections and
wrong/absent-password rejection, then compare the saved aggregate counts
and inspect affected customer and credit records privately. A green CI
rehearsal, `role_uses_scram=true` alone, or an `/api/health` response
cannot satisfy that operational release gate.

Keep Issue #31's real carrier calls, durable proxy route and invoice/credit
checks separate. Keep Issue #24 open until Telnyx restores compliance API
access and an approved sender passes real SMS delivery/STOP acceptance.
