#!/bin/sh
# F12-D: read-only validation of the existing DeployOS Traefik bridge.
# Prints topology only; it does not modify Docker networks, routes or certificates.
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker CLI not found; run this on the current DeployOS Docker host.' >&2
  exit 1
fi

traefik=${AI_CALLER_TRAEFIK_CONTAINER:-traefik-edge}
if ! docker inspect "$traefik" >/dev/null 2>&1; then
  echo "Traefik container '$traefik' was not found." >&2
  exit 1
fi
running=$(docker inspect --format '{{.State.Running}}' "$traefik")
if [ "$running" != true ]; then
  echo "Traefik container '$traefik' is not running." >&2
  exit 1
fi

dynamic_source=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/dynamic"}}{{.Source}}{{end}}{{end}}' "$traefik")
if [ -z "$dynamic_source" ] || [ ! -d "$dynamic_source" ]; then
  echo 'Traefik does not expose a host-backed /dynamic directory on this installation.' >&2
  exit 1
fi

web=${AI_CALLER_WEB_CONTAINER:-}
if [ -z "$web" ]; then
  matches=$(docker ps     --filter label=com.docker.compose.project=ai-caller     --filter label=com.docker.compose.service=web     --format '{{.ID}}')
  set -- $matches
  if [ "$#" -ne 1 ]; then
    echo 'Expected one running AI Caller web container. Set AI_CALLER_WEB_CONTAINER explicitly if needed.' >&2
    exit 1
  fi
  web=$1
fi

project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$web")
service=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$web")
if [ "$project" != ai-caller ] || [ "$service" != web ]; then
  echo 'Refusing to inspect a web container outside the ai-caller/web Compose service.' >&2
  exit 1
fi

edge_present=$(docker inspect --format '{{if index .NetworkSettings.Networks "edge"}}yes{{else}}no{{end}}' "$web")
if [ "$edge_present" != yes ]; then
  echo 'AI Caller web is not attached to DeployOS edge; deploy the persistent Compose network change first.' >&2
  exit 1
fi
aliases=$(docker inspect --format '{{with index .NetworkSettings.Networks "edge"}}{{range .Aliases}}{{println .}}{{end}}{{end}}' "$web")
if ! printf '%s\n' "$aliases" | grep -qx aicaller-web; then
  echo 'AI Caller web is on edge but missing the required aicaller-web alias.' >&2
  exit 1
fi

edge_matches=$(docker ps \
  --filter label=com.docker.compose.project=ai-caller \
  --filter label=com.docker.compose.service=edge-reconciler \
  --format '{{.ID}}')
set -- $edge_matches
if [ "$#" -ne 1 ]; then
  echo 'Expected one running dedicated ai-caller/edge-reconciler container.' >&2
  exit 1
fi
edge_reconciler=$1
edge_source=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/.data/traefik-domains"}}{{.Source}}{{end}}{{end}}' "$edge_reconciler")
if [ -z "$edge_source" ] || [ ! -d "$edge_source" ]; then
  echo 'Dedicated edge reconciler is missing its writable Traefik dynamic-directory mount.' >&2
  exit 1
fi
if [ "$(readlink -f "$edge_source")" != "$(readlink -f "$dynamic_source")" ]; then
  echo 'Edge reconciler writes to a different directory than Traefik watches.' >&2
  exit 1
fi

printf 'traefik_container=%s\n' "$traefik"
printf 'traefik_dynamic_host_dir=%s\n' "$dynamic_source"
printf 'web_container=%s\n' "$web"
printf 'web_edge_network=yes\n'
printf 'web_edge_alias=aicaller-web\n'
printf 'edge_reconciler_dynamic_mount=matches_traefik\n'

if [ -f "$dynamic_source/aicaller.yml" ]; then
  echo 'deployos_generated_web_route=present'
else
  echo 'deployos_generated_web_route=not_found (review DeployOS proxy configuration before enabling Whitelabel routes)'
fi

echo 'Read-only Traefik preflight complete. No route, network or certificate was modified.'
