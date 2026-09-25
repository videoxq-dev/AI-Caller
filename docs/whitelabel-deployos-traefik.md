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
AI Caller edge reconciler
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

The dedicated edge reconciler never receives the Docker socket. The general web and worker processes do not receive the Traefik dynamic-directory mount.

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

### 3. Configure the edge-reconciler bind mount

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

Then redeploy the dedicated edge reconciler.

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

The dedicated edge reconciler periodically reconciles route files:

- `VERIFIED`, `CERT_PENDING`, `CERT_READY`, `ACTIVE`: route should exist.
- `DNS_MISMATCH`, `REVOKED`, `DISABLING`, `DISABLED`: route should not exist.
- Unchanged route content is not rewritten, avoiding unnecessary Traefik reloads.

Disconnect/revocation is fail-closed: route removal is queued immediately and also repaired by periodic recovery.

## TLS boundary

Traefik is responsible for ACME issuance and renewal. The router references the configured certificate resolver, but **F12-D3 does not mark a certificate READY**. F12-D5 performs an independent public TLS/SNI probe before setting `CERT_READY`.

Keep ACME storage persistent in the Traefik deployment. Use a staging ACME resolver for infrastructure rehearsal if available before production issuance.


## F12-D5 certificate readiness contract

Traefik remains the ACME issuer and renewal authority. AI Caller does not parse `acme.json` and does not infer success merely because a router file exists.

The dedicated edge reconciler independently verifies public readiness:

1. connect to the configured `WHITELABEL_PUBLIC_IPV4` on port 443;
2. send the purchaser hostname as TLS SNI;
3. require normal CA/hostname certificate validation;
4. send the same hostname as the HTTP `Host` header;
5. require an HTTP 2xx/3xx response from the custom-host route;
6. record the peer certificate expiration date.

Only then does `CERT_PENDING` become `CERT_READY`.

The probe is deliberately pinned to the configured AI Caller edge IP rather than resolving the purchaser-controlled hostname for the outbound connection. This proves our edge is serving the certificate and avoids using custom DNS as an arbitrary outbound-network destination.

A failed probe while the certificate is still pending leaves it in `CERT_PENDING` with an actionable error. A transient failed audit does not automatically downgrade a previously ready/active hostname. Certificates within 21 days of their recorded expiration are re-probed so renewed certificate metadata is refreshed.

The TLS probe timeout is bounded with:

```dotenv
WHITELABEL_TLS_PROBE_TIMEOUT_MS=8000
```

F12-D8 still requires a real controlled hostname to prove ACME issuance, renewal-ready persistence and public HTTPS on the deployed server.


## D5 independent TLS readiness

A generated Traefik route does not make a domain `CERT_READY`.

The dedicated edge reconciler probes the configured AI Caller public IPv4 address directly on port 443 while using the purchaser hostname as TLS SNI and the HTTP `Host` header. This prevents purchaser-controlled DNS from redirecting the probe to arbitrary network targets.

Readiness requires all of the following:

1. the TLS handshake is trusted for the purchaser hostname;
2. the certificate has a future expiration date;
3. HTTPS returns a successful response; and
4. the response is the expected AI Caller Whitelabel holding-route marker for that hostname.

Only then does `CERT_PENDING` become `CERT_READY`. Certificate expiry is persisted for renewal monitoring.

Transient probe failures do not downgrade an already-ready domain; they are recorded as diagnostic errors and retried. Domains with certificates nearing expiry are periodically re-probed so renewal failures become visible without replacing Traefik's own ACME renewal responsibility.
