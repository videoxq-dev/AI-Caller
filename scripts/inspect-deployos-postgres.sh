#!/bin/sh
# Issue #28: read-only inventory of the EXISTING AI Caller DeployOS database.
# Prints only Docker topology, authentication summaries, and aggregate row counts.
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker CLI not found; run this on the current DeployOS Docker host.' >&2
  exit 1
fi

container=${AI_CALLER_DB_CONTAINER:-}
if [ -z "$container" ]; then
  matches=$(docker ps \
    --filter label=com.docker.compose.project=ai-caller \
    --filter label=com.docker.compose.service=postgres \
    --format '{{.ID}}')
  # Docker container IDs contain no spaces; require exactly one project DB.
  set -- $matches
  if [ "$#" -ne 1 ]; then
    echo 'Expected one running AI Caller PostgreSQL container. Set AI_CALLER_DB_CONTAINER to its exact Docker name/ID.' >&2
    exit 1
  fi
  container=$1
fi

project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")
service=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")
if [ "$project" != ai-caller ] || [ "$service" != postgres ]; then
  echo 'Refusing to inspect a container outside the existing ai-caller/postgres Compose service.' >&2
  exit 1
fi

volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$container")
if [ -z "$volume" ]; then
  echo 'No named PostgreSQL data volume found; identify the storage before proceeding.' >&2
  exit 1
fi

printf 'compose_project=%s\npostgres_service=%s\npostgres_container=%s\npostgres_data_volume=%s\n' \
  "$project" "$service" "$container" "$volume"
if docker port "$container" 5432/tcp >/dev/null 2>&1; then
  echo 'postgres_host_port_published=yes (review exposure before migration)'
else
  echo 'postgres_host_port_published=no'
fi

# No secret values, database rows, role password hashes, HBA addresses or
# application configuration are printed. -w disallows interactive prompts;
# unix-socket authentication must work or inspection fails without mutation.
docker exec -u postgres "$container" sh -eu -c '
  role=${POSTGRES_USER:-postgres}
  database=${POSTGRES_DB:-ai_caller}
  export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000"
  psql -X -q -w -v ON_ERROR_STOP=1 -At -U "$role" -d "$database" <<SQL
SELECT '\''pg_version='\'' || current_setting('\''server_version'\'');
SELECT '\''role_uses_scram='\'' || COALESCE((SELECT (rolpassword LIKE '\''SCRAM-SHA-256$%'\'')::text FROM pg_authid WHERE rolname = current_user), '\''false'\'');
SELECT '\''hba_parse_errors='\'' || count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;
SELECT '\''hba_host_non_scram='\'' || count(*) FROM pg_hba_file_rules WHERE type LIKE '\''host%'\'' AND auth_method <> '\''scram-sha-256'\'';
SELECT '\''workspaces='\'' || count(*) FROM public.workspaces;
SELECT '\''contacts='\'' || count(*) FROM public.contacts;
SELECT '\''conversations='\'' || count(*) FROM public.conversations;
SELECT '\''messages='\'' || count(*) FROM public.messages;
SELECT '\''appointments='\'' || count(*) FROM public.appointments;
SELECT '\''credit_wallets='\'' || count(*) FROM public.credit_wallets;
SELECT '\''credit_ledger='\'' || count(*) FROM public.credit_ledger;
SELECT '\''credit_wallet_total_credits='\'' || COALESCE(sum(balance), 0) FROM public.credit_wallets;
SELECT '\''credit_ledger_amount_total_credits='\'' || COALESCE(sum(amount), 0) FROM public.credit_ledger;
SQL
'

echo 'Read-only inventory complete. No backup, migration, password rotation or restart performed.'
