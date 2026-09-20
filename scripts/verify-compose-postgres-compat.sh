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
cleanup() {
  docker rm -f "$old" >/dev/null 2>&1 || true
  docker compose -p "$project" -f docker-compose.yml down --remove-orphans >/dev/null 2>&1 || true
  docker compose -p "$fresh" -f docker-compose.yml down --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$volume" "$fresh_volume" >/dev/null 2>&1 || true
  rm -f "$temp_log"
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

# Model the OLD Compose file's real persisted role, hostname and trust HBA.
docker volume create "$volume" >/dev/null
docker run -d --name "$old" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=ai_caller_auto_pass \
  -e POSTGRES_DB=ai_caller -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$volume:/var/lib/postgresql/data" postgres:16-alpine >/dev/null
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
