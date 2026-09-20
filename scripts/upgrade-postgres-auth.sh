#!/bin/sh
# Data-preserving, one-time migration for the EXISTING running PostgreSQL 16
# container. Run only after confirming an offline pg_dumpall backup/restore.
set -eu

if [ "${AI_CALLER_POSTGRES_BACKUP_VERIFIED:-}" != "YES" ]; then
  echo "Refusing to change PostgreSQL auth: verified backup acknowledgement required." >&2
  exit 1
fi

secret_file=${AI_CALLER_POSTGRES_NEW_PASSWORD_FILE:-}
if [ -z "$secret_file" ] || [ ! -f "$secret_file" ]; then
  echo "Provide a private file containing the new PostgreSQL password." >&2
  exit 1
fi
password=$(cat "$secret_file")
if [ "${#password}" -lt 32 ] || [ "$password" = "ai_caller_auto_pass" ]; then
  echo "New database password must be unique and at least 32 characters." >&2
  exit 1
fi

role=${POSTGRES_USER:-postgres}
database=${POSTGRES_DB:-ai_caller}
pgdata=${PGDATA:-/var/lib/postgresql/data}
if ! printf '%s' "$role" | grep -Eq '^[a-zA-Z_][a-zA-Z0-9_]*$'; then
  echo "Unexpected PostgreSQL role name; aborting." >&2
  exit 1
fi
if [ ! -f "$pgdata/pg_hba.conf" ]; then
  echo "Existing PostgreSQL data directory was not found; aborting." >&2
  exit 1
fi
backup="$pgdata/pg_hba.conf.before-ai-caller-scram"
if [ ! -f "$backup" ]; then cp -p "$pgdata/pg_hba.conf" "$backup"; fi
# psql SQL string literal escaping; never put the password in command-line args.
escaped=$(printf '%s' "$password" | sed "s/'/''/g")
psql -X -q -U "$role" -d "$database" -v ON_ERROR_STOP=1 >/dev/null <<SQL
SET password_encryption = 'scram-sha-256';
ALTER ROLE "$role" WITH LOGIN PASSWORD '$escaped';
SQL
# Match only HOST entries; keep unix-socket local rules unchanged. Existing
# trust/md5/password network entries (including hostssl) become SCRAM.
sed -i -E '/^[[:space:]]*host[^[:space:]]*[[:space:]]/s/[[:space:]]+(trust|md5|password)([[:space:]]*(#.*)?)$/ scram-sha-256\2/' "$pgdata/pg_hba.conf"
if grep -Eq '^[[:space:]]*host[^[:space:]]*[[:space:]].*[[:space:]](trust|md5|password)([[:space:]]|$)' "$pgdata/pg_hba.conf"; then
  echo "A legacy network weak authentication entry remains. Inspect pg_hba.conf manually." >&2
  exit 1
fi
psql -X -q -U "$role" -d "$database" -v ON_ERROR_STOP=1 -Atc "SELECT pg_reload_conf()" |
  grep -qx 't' || { echo "PostgreSQL reload failed." >&2; exit 1; }

# Check a real TCP login using the new secret; this catches role/HBA mismatches.
PGPASSWORD="$password" psql -X -q -w -h 127.0.0.1 -U "$role" -d "$database" -v ON_ERROR_STOP=1 -Atc "SELECT 1" |
  grep -qx '1' || { echo "Authenticated TCP login failed; restore HBA backup and investigate." >&2; exit 1; }
echo "SCRAM role and host authentication activated. Keep the backup and deploy the updated DATABASE_URL and Compose secrets."
