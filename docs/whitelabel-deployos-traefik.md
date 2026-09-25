# F12-D DeployOS Traefik bridge for Whitelabel custom domains

This document records the **observed AI Caller DeployOS edge topology** and the repository-controlled bridge used by F12-D. It does not replace DeployOS or create a second Traefik deployment.

## Existing edge observed on this installation

The Realtime deployment work already established:

- Traefik container: `traefik-edge`
- External Docker network: `edge`
- Traefik file-provider host directory:
  `/opt/deployos/traefik/dynamic/generated`
- File-provider container directory: `/dynamic`
- HTTPS entry point: `websecure`
- ACME certificate resolver: `letsencrypt`
- Existing generated AI Caller web service target:
  `http://aicaller-web:8080`

Traefik's file provider watches a directory and reloads dynamic configuration when files change. The directory itself, rather than an individual file, should be bind-mounted so filesystem notifications survive atomic file replacement.

## Architecture

PostgreSQL remains the desired-state source of truth.

```text
whitelabel_domains
      |
      v
AI Caller worker
      |
      | atomic *.yml files
      v
/app/.data/traefik-domains
      |
      | bind mount
      v
/opt/deployos/traefik/dynamic/generated
      |
      v
traefik-edge
      |
      v
aicaller-web:8080
```

The worker never receives the Docker socket.

Every domain gets one deterministic route file. If DeployOS removes custom files during redeployment, the worker recovery loop recreates the desired files from PostgreSQL without changing the purchaser's domain record.

## Safe rollout

### 1. Deploy with route writes disabled

Keep:

```dotenv
WHITELABEL_DOMAIN_ROUTE_ENABLED=false
```

The Compose change attaches `web` persistently to `edge` using alias `aicaller-web`, while keeping the default private network for PostgreSQL.

### 2. Run the read-only preflight on the VPS

```sh
sh scripts/inspect-deployos-traefik.sh
```

It must confirm:

- `traefik-edge` is running;
- Traefik has a host-backed `/dynamic` directory;
- `ai-caller/web` is on `edge`;
- the `aicaller-web` alias exists.

The script does not create routes, connect networks or request certificates.

### 3. Configure the worker bind mount

For the observed DeployOS installation:

```dotenv
WHITELABEL_TRAEFIK_DYNAMIC_HOST_DIR=/opt/deployos/traefik/dynamic/generated
WHITELABEL_TRAEFIK_DYNAMIC_DIR=/app/.data/traefik-domains
WHITELABEL_TRAEFIK_ENTRYPOINT=websecure
WHITELABEL_TRAEFIK_CERT_RESOLVER=letsencrypt
WHITELABEL_TRAEFIK_SERVICE_URL=http://aicaller-web:8080
```

### 4. Enable route reconciliation

Only after the preflight succeeds:

```dotenv
WHITELABEL_DOMAIN_ROUTE_ENABLED=true
```

Then redeploy the worker.

A domain in `VERIFIED` state will receive a dynamic router file and advance to `CERT_PENDING`.

## Generated route shape

Each generated file is intentionally small and contains one router/service pair:

```yaml
http:
  routers:
    wl-<domain-id>:
      rule: "Host(`app.customer.example`)"
      entryPoints:
        - websecure
      service: wl-<domain-id>
      tls:
        certResolver: letsencrypt
  services:
    wl-<domain-id>:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: "http://aicaller-web:8080"
```

The hostname comes only from the normalized database domain record. Purchasers cannot supply route IDs, YAML, service URLs, entry points or certificate resolver names.

## Recovery behavior

The worker periodically reconciles route files:

- `VERIFIED`, `CERT_PENDING`, `CERT_READY`, `ACTIVE`: route should exist.
- `DNS_MISMATCH`, `REVOKED`, `DISABLING`, `DISABLED`: route should not exist.
- Unchanged route content is not rewritten, avoiding unnecessary Traefik reloads.

Disconnect/revocation is fail-closed: route removal is queued immediately and also repaired by periodic recovery.

## TLS boundary

Traefik is responsible for ACME issuance and renewal. The router references the configured certificate resolver, but **F12-D3 does not mark a certificate READY**. F12-D5 performs an independent public TLS/SNI probe before setting `CERT_READY`.

Keep ACME storage persistent in the Traefik deployment. Use a staging ACME resolver for infrastructure rehearsal if available before production issuance.
