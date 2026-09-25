# F12-D8 — Real-domain acceptance and authoritative close

The repository CI proves the database, DNS state machine, Traefik route generator,
holding-host guard, TLS probe logic, and lifecycle regressions. It **cannot** prove
that the deployed VPS currently serves a publicly trusted certificate for a
customer-owned domain. Complete this one-time live gate before reporting F12-D
as production-ready.

## Preconditions

Use a controlled test hostname such as `clients.demo-brand.example.com`
(replace with a **real domain that you control**, not the documentation example).

Confirm on the actual DeployOS VPS:

1. `main` has been deployed with migrations through
   `0044_whitelabel_domains.sql`.
2. `sh scripts/inspect-deployos-traefik.sh` succeeds and reports the actual
   mounted Traefik `/dynamic` directory and `aicaller-web` on `edge`.
3. Public port **80** is reachable for the configured Traefik ACME HTTP-01
   challenge, and port **443** is reachable for HTTPS.
4. Traefik's `letsencrypt` resolver exists and its ACME storage is persistent
   outside disposable container storage. Do not disclose or copy certificate
   private keys into tickets or logs.
5. The `edge-reconciler` bind mount points to the directory watched by the
   existing Traefik file provider, not an unrelated local directory.
6. Set the real `WHITELABEL_PUBLIC_IPV4`, canonical host and (only if deployed)
   IPv6 address. Start with `WHITELABEL_DOMAIN_ROUTE_ENABLED=false` until
   the read-only proxy preflight is complete.
7. The test purchaser has Core + Agency + Whitelabel and has connected the
   exact test hostname under **AI Caller → Whitelabel**.

## DNS and activation

In the purchaser's Whitelabel page, copy the current A and TXT instructions.
Add the purchaser-specific TXT proof alongside the A record at the domain's DNS
provider. Resolve any conflicting AAAA records. Do not share or print the TXT
proof publicly.

Press **Verify DNS** and confirm the page moves through VERIFIED and
CERT_PENDING. Enable `WHITELABEL_DOMAIN_ROUTE_ENABLED=true` only after the
preflight; redeploy the dedicated edge reconciler. Inspect only the generated
`wl-*.yml` for this domain, never manually edit DeployOS's canonical
`aicaller.yml` or the voice gateway route. Traefik handles ACME issuance
and renewal; AI Caller does not write to `acme.json`.

A Let's Encrypt **staging** rehearsal may precede the production certificate.
Staging certificates are intentionally untrusted by public browsers, so they
cannot pass the final HTTPS acceptance probe. Switch to the existing production
resolver for the final real-domain gate after staging is healthy.

## Execute the live, read-only probe

Run from the VPS or a trusted external machine with the project installed.
Set these variables for **this controlled test hostname**, using the actual
edge IP shown in AI Caller. Read the expected TXT value privately, without
placing it in shell history:

```sh
export WHITELABEL_TEST_HOST=clients.your-real-domain.com
export WHITELABEL_PUBLIC_IPV4=YOUR_REAL_EDGE_IPV4
# Set WHITELABEL_PUBLIC_IPV6 only when this edge actually serves IPv6.
read -r -s WHITELABEL_TEST_TXT
export WHITELABEL_TEST_TXT
node scripts/verify-whitelabel-domain-live.mjs
unset WHITELABEL_TEST_TXT
```

The probe checks:

- all public A records resolve to the expected edge;
- AAAA records do not point at a conflicting server;
- the exact current purchaser TXT proof resolves;
- HTTPS connects to that edge with the **customer hostname as SNI**;
- the served certificate is trusted, valid for that hostname and unexpired;
- the custom root and a canonical auth-path request both return only the
  domain-specific Whitelabel holding JSON, not the AI Caller sign-in;
- when `DATABASE_URL` is available, the live domain record says CERT_READY and
  contains DNS and route verification timestamps.

The probe prints **no TXT token**. Share its success/failure summary, certificate
issuer and expiry only.

## Persistence and negative acceptance

Record sanitized evidence, then perform each check:

1. Repeat the probe after restarting **only the AI Caller web** container.
2. Repeat after restarting the **edge-reconciler** container; missing desired
   `wl-*.yml` should be recreated from PostgreSQL.
3. Repeat after restarting **Traefik** and after a **DeployOS redeploy**; the
   verified certificate and active DNS/route state must survive.
4. Close the DeployOS desktop app while leaving VPS services running and repeat.
5. Verify the original canonical AI Caller URL and the separate voice-gateway
   URL remain healthy; unrelated Whitelabel domains must not be affected.
6. Temporarily refund a *test purchaser's* Whitelabel or remove another required
   product and confirm the custom host becomes unavailable immediately, while
   the edge worker removes its route. Do not refund a real customer's purchase
   for this test.
7. Reinstate the test purchaser, choose **Reconnect domain**, publish the new
   TXT proof, reverify DNS, and require a fresh trusted TLS/holding result.

Do not claim the refund/restore portion passed unless it was actually exercised
on test data and the clean restoration was verified.

## Final completion criteria

F12-D may be marked **authoritatively closed** only after the exact deployed
commit is green in repository CI **and** the real controlled domain passes
the DNS/TLS/route test before and after restart/redeploy. Record the hostname
(redact the private TXT proof), deployed commit, Traefik version, ACME resolver,
certificate expiry, preflight result, probe result, and evidence for route removal.

The domain remains `CERT_READY` with a neutral holding response. Full client
login and a branded workspace experience are F12-E/F, not F12-D.
