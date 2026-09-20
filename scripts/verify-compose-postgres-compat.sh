#!/bin/sh
# CI ONLY: exercise the real historical PostgreSQL volume -> PR #30 upgrade.
# Never run this against a deployment. Every Docker resource uses a unique test name.
set -eu
if [ "${AI_CALLER_E2E_FIXTURES:-}" != "1" ]; then
  echo "Refusing to touch Docker without the CI fixture guard." >&2
  exit 1
fi

project="ai-caller-db-compat-${GITHUB_RUN_ID:-$$}"
fresh="${project}-fresh"
volume="${project}_postgres_data"
fresh_volume="${fresh}_postgres_data"
old="${project}-legacy"
temp_log="$(mktemp)"
temp_dump="$(mktemp)"
cleanup() {
  docker rm -f "$old" >/dev/null 2>&1 || true
  docker compose -p "$project" -f docker-compose.yml down --remove-orphans >/dev/null 2>&1 || true
  docker compose -p "$fresh" -f docker-compose.yml down --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$volume" "$fresh_volume" >/dev/null 2>&1 || true
  rm -f "$temp_log" "$temp_dump"
}
trap cleanup EXIT HUP INT TERM

# A brand-new volume must NEVER start with the former published fallback password.
if env -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB \
  docker compose -p "$fresh" -f docker-compose.yml run --rm --no-deps postgres >"$temp_log" 2>&1; then
  echo "Unsafe fresh database unexpectedly bootstrapped without a strong password." >&2
  exit 1
fi
if ! grep -q 'Refusing to create an insecure new database' "$temp_log"; then
  echo "Fresh database failed for a different reason; inspect CI job logs." >&2
  exit 1
fi
echo "PASS: empty PostgreSQL volume cannot initialize with legacy fallback."

# A fresh install STILL auto-provisions the same private database when a
# strong password is supplied; wrong-password TCP access must be rejected.
fresh_password="ci-strong-scram-password-1234567890"
env POSTGRES_PASSWORD="$fresh_password" \
  docker compose -p "$fresh" -f docker-compose.yml up -d --no-build postgres >/dev/null
attempt=0
until docker compose -p "$fresh" -f docker-compose.yml exec -T \
  -e PGPASSWORD="$fresh_password" postgres \
  psql -h 127.0.0.1 -U postgres -d ai_caller -Atc "select 1" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Fresh PostgreSQL with explicit strong password did not become reachable." >&2
    exit 1
  fi
  sleep 1
done
if docker compose -p "$fresh" -f docker-compose.yml exec -T \
  -e PGPASSWORD="definitely-wrong-password" postgres \
  psql -h 127.0.0.1 -U postgres -d ai_caller -Atc "select 1" >/dev/null 2>&1; then
  echo "Fresh PostgreSQL unexpectedly accepted a wrong TCP password." >&2
  exit 1
fi
echo "PASS: fresh PostgreSQL auto-provisions with SCRAM and rejects wrong passwords."

# Model the OLD Compose file's real persisted role, hostname and trust HBA.
docker volume create "$volume" >/dev/null
docker run -d --name "$old" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=ai_caller_auto_pass \
  -e POSTGRES_DB=ai_caller -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$volume:/var/lib/postgresql/data" postgres:16-alpine >/dev/null
# postgres:16-alpine briefly starts an INIT-only UNIX socket, then shuts it
# down and starts the real server. Do not write the marker during that window.
attempt=0
until docker logs "$old" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Legacy isolated PostgreSQL did not finish bootstrap." >&2
    exit 1
  fi
  sleep 1
done
attempt=0
until docker exec "$old" pg_isready -U postgres -d ai_caller >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Legacy isolated PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 1
done
docker exec "$old" psql -U postgres -d ai_caller -v ON_ERROR_STOP=1 \
  -c "create table ai_caller_db_upgrade_marker (id integer primary key)" >/dev/null
docker exec "$old" psql -U postgres -d ai_caller -v ON_ERROR_STOP=1 \
  -c "insert into ai_caller_db_upgrade_marker values (1)" >/dev/null
# Export real fixture rows BEFORE touching the old volume. Restore the dump in
# the isolated fresh SCRAM database to prove this artifact is usable.
docker exec "$old" pg_dump -U postgres -d ai_caller \
  -t public.ai_caller_db_upgrade_marker >"$temp_dump"
if [ ! -s "$temp_dump" ]; then
  echo "Legacy fixture dump is empty; refusing to continue." >&2
  exit 1
fi
env POSTGRES_PASSWORD="$fresh_password" \
  docker compose -p "$fresh" -f docker-compose.yml exec -T \
  -e PGPASSWORD="$fresh_password" postgres \
  psql -X -q -w -h 127.0.0.1 -U postgres -d ai_caller -v ON_ERROR_STOP=1 <"$temp_dump"
restored="$(env POSTGRES_PASSWORD="$fresh_password" \
  docker compose -p "$fresh" -f docker-compose.yml exec -T \
  -e PGPASSWORD="$fresh_password" postgres \
  psql -X -q -w -h 127.0.0.1 -U postgres -d ai_caller -Atc \
  "select count(*) from ai_caller_db_upgrade_marker")"
if [ "$restored" != "1" ]; then
  echo "Legacy backup did not restore its marker data." >&2
  exit 1
fi
echo "PASS: legacy data dump restores in a disposable authenticated database."

docker stop "$old" >/dev/null
docker rm "$old" >/dev/null

# The restored default Compose MUST reuse the same persistent volume and data.
env -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB \
  docker compose -p "$project" -f docker-compose.yml up -d --no-build postgres >/dev/null
attempt=0
until docker compose -p "$project" -f docker-compose.yml exec -T postgres \
  pg_isready -U postgres -d ai_caller >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Restored Compose did not start the original PostgreSQL volume." >&2
    exit 1
  fi
  sleep 1
done
count="$(docker compose -p "$project" -f docker-compose.yml exec -T postgres \
  psql -U postgres -d ai_caller -Atc "select count(*) from ai_caller_db_upgrade_marker")"
if [ "$count" != "1" ]; then
  echo "Original persisted PostgreSQL data was not retained." >&2
  exit 1
fi
echo "PASS: old bundled PostgreSQL volume and stored records survive Compose upgrade."

# Exercise the actual operator migration script on this disposable legacy
# volume. The production volume and credentials are NEVER part of CI.
db_container="$(env -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB \
  docker compose -p "$project" -f docker-compose.yml ps -q postgres)"
if [ -z "$db_container" ]; then
  echo "Unable to identify the isolated legacy PostgreSQL container." >&2
  exit 1
fi
docker cp scripts/upgrade-postgres-auth.sh "$db_container:/tmp/upgrade-postgres-auth.sh"
legacy_rotated_password="ci-rotated-scram-password-1234567890"
docker exec -u postgres "$db_container" sh -ec \
  'umask 077; printf %s "$1" > /tmp/ai-caller-new-db-password' \
  sh "$legacy_rotated_password"
docker exec -u postgres \
  -e AI_CALLER_POSTGRES_BACKUP_VERIFIED=YES \
  -e AI_CALLER_POSTGRES_NEW_PASSWORD_FILE=/tmp/ai-caller-new-db-password \
  "$db_container" sh /tmp/upgrade-postgres-auth.sh
if ! docker exec -e PGPASSWORD="$legacy_rotated_password" "$db_container" \
  psql -X -q -w -h 127.0.0.1 -U postgres -d ai_caller -Atc \
  "select count(*) from ai_caller_db_upgrade_marker" | grep -qx '1'; then
  echo "Authenticated legacy migration lost data or rejected its new password." >&2
  exit 1
fi
if docker exec -e PGPASSWORD="definitely-wrong-password" "$db_container" \
  psql -X -q -w -h 127.0.0.1 -U postgres -d ai_caller -Atc 'select 1' >/dev/null 2>&1; then
  echo "Migrated legacy database accepted a wrong password." >&2
  exit 1
fi
if docker exec -u postgres -e PGPASSWORD= "$db_container" \
  psql -X -q -w -h 127.0.0.1 -U postgres -d ai_caller -Atc 'select 1' >/dev/null 2>&1; then
  echo "Migrated legacy database accepted a passwordless TCP connection." >&2
  exit 1
fi
# Confirm the *active parsed* HBA rules, not merely text in the config file.
if ! docker exec "$db_container" psql -X -q -U postgres -d ai_caller -Atc \
  "select count(*) from pg_hba_file_rules where error is not null or (type like 'host%' and auth_method <> 'scram-sha-256')" | grep -qx '0'; then
  echo "Migrated HBA contains invalid or non-SCRAM network authentication." >&2
  exit 1
fi
docker exec -u postgres "$db_container" rm -f /tmp/ai-caller-new-db-password
# docker cp creates the migration script as root-owned, so only root may
# remove this *fixture* script; the production operator's script is separate.
docker exec "$db_container" rm -f /tmp/upgrade-postgres-auth.sh
echo "PASS: backup-gated migration secures the same volume and rejects missing/wrong TCP passwords."

