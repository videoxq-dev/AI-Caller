"use client";

import { useEffect, useState } from "react";

type DomainState = {
  id: string;
  hostname: string;
  status: string;
  certificateStatus: string;
  aVerifiedAt: string | null;
  txtVerifiedAt: string | null;
  dnsVerifiedAt: string | null;
  routeProvisionedAt: string | null;
  certificateReadyAt: string | null;
  certificateExpiresAt: string | null;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  dns: {
    ipv4: string | null;
    ipv6: string | null;
    verificationRecordName: string;
    verificationRecordValue: string;
  };
};

function apiMessage(data: unknown, fallback: string) {
  if (data && typeof data === "object" && "error" in data) {
    const error = data.error;
    if (error && typeof error === "object" && "message" in error
      && typeof error.message === "string") return error.message;
  }
  return fallback;
}

export function WhitelabelDomainPanel() {
  const [domain, setDomain] = useState<DomainState | null>(null);
  const [hostname, setHostname] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch("/api/whitelabel/domain", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(apiMessage(data, "Unable to load custom-domain settings."));
    setDomain(data.domain);
    return data.domain as DomainState | null;
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/whitelabel/domain", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(apiMessage(data, "Unable to load custom-domain settings."));
        if (!cancelled) setDomain(data.domain);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load custom-domain settings."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function connect() {
    if (!hostname.trim()) return;
    setBusy("connect");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/whitelabel/domain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostname }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "Unable to connect custom domain."));
      setDomain(data.domain);
      setHostname("");
      setNotice("Domain reserved. Add the DNS records below, then verify.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to connect custom domain.");
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    if (!domain) return;
    const previousCheck = domain.lastCheckedAt;
    setBusy("verify");
    setError(null);
    setNotice("DNS verification queued.");
    try {
      const response = await fetch("/api/whitelabel/domain/verification", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "Unable to verify DNS."));
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const current = await load();
        if (current?.lastCheckedAt && current.lastCheckedAt !== previousCheck) {
          setNotice(["VERIFIED", "CERT_PENDING", "CERT_READY", "ACTIVE"].includes(current.status)
            ? "DNS ownership and routing records are verified."
            : "DNS was checked. Review the record status below.");
          return;
        }
      }
      setNotice("Verification is still processing. Use Recheck status in a moment.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to verify DNS.");
    } finally {
      setBusy(null);
    }
  }

  async function rotate() {
    setBusy("rotate");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/whitelabel/domain/verification/rotate", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "Unable to rotate verification record."));
      setDomain(data.domain);
      setNotice("Verification value rotated. Update the TXT record before verifying again.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to rotate verification record.");
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect this custom domain? The saved brand remains unchanged.")) return;
    setBusy("disconnect");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/whitelabel/domain", { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "Unable to disconnect custom domain."));
      setDomain(null);
      setNotice("Custom domain disconnected.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to disconnect custom domain.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="wlCard wlDomainCard">
      <div className="wlSectionHeading">
        <h2>Custom domain</h2>
        <p>Connect one subdomain for your branded client platform. After DNS verification, AI Caller provisions the edge route and HTTPS certificate.</p>
      </div>

      {error && <div className="wlError" role="alert">{error}</div>}
      {notice && <div className="wlNotice" role="status">{notice}</div>}

      {loading ? <p className="wlEmpty">Loading domain settings…</p> : !domain ? (
        <div className="wlDomainConnect">
          <label>
            <span>Client platform domain</span>
            <input
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              placeholder="app.yourbrand.com"
              autoCapitalize="none"
              autoCorrect="off"
            />
          </label>
          <button className="wlPrimary" type="button" disabled={!hostname.trim() || busy !== null} onClick={() => void connect()}>
            {busy === "connect" ? "Connecting…" : "Connect domain"}
          </button>
        </div>
      ) : (
        <div className="wlDomainState">
          <div className="wlDomainSummary">
            <div><span>Domain</span><strong>{domain.hostname}</strong></div>
            <span className={["VERIFIED", "CERT_PENDING", "CERT_READY", "ACTIVE"].includes(domain.status) ? "wlDomainGood" : "wlDomainPending"}>
              {domain.status === "VERIFIED"
                ? "DNS verified"
                : domain.status === "CERT_PENDING"
                  ? "HTTPS provisioning"
                  : domain.status === "CERT_READY" || domain.status === "ACTIVE"
                    ? "HTTPS ready"
                    : domain.status.replaceAll("_", " ").toLowerCase()}
            </span>
          </div>

          <div className="wlDnsRecords">
            <DnsRecord type="A" name={domain.hostname} value={domain.dns.ipv4 ?? "Server edge not configured"} ok={Boolean(domain.aVerifiedAt)} />
            {domain.dns.ipv6 && <DnsRecord type="AAAA" name={domain.hostname} value={domain.dns.ipv6} ok={Boolean(domain.dnsVerifiedAt)} />}
            <DnsRecord type="TXT" name={domain.dns.verificationRecordName} value={domain.dns.verificationRecordValue} ok={Boolean(domain.txtVerifiedAt)} />
          </div>

          {domain.lastErrorMessage && (
            <div className="wlDomainIssue">
              <strong>{domain.lastErrorCode?.replaceAll("_", " ")}</strong>
              <span>{domain.lastErrorMessage}</span>
            </div>
          )}

          <div className="wlDomainMeta">
            <span>DNS ownership <b>{domain.dnsVerifiedAt ? "Verified" : "Pending"}</b></span>
            <span>Routing <b>{domain.routeProvisionedAt ? "Ready" : "Pending"}</b></span>
            <span>SSL certificate <b>{
              domain.certificateStatus === "READY"
                ? "Ready"
                : domain.certificateStatus === "PENDING"
                  ? "Provisioning"
                  : domain.certificateStatus === "FAILED"
                    ? "Needs attention"
                    : "Pending"
            }</b></span>
            {domain.certificateExpiresAt && (
              <span>Certificate expires <b>{new Date(domain.certificateExpiresAt).toLocaleDateString()}</b></span>
            )}
            {domain.certificateExpiresAt && <span>Certificate expires <b>{new Date(domain.certificateExpiresAt).toLocaleDateString()}</b></span>}
            {domain.lastCheckedAt && <span>Last DNS check <b>{new Date(domain.lastCheckedAt).toLocaleString()}</b></span>}
          </div>

          <div className="wlDomainActions">
            <button className="wlPrimary" type="button" disabled={busy !== null || !domain.dns.ipv4} onClick={() => void verify()}>
              {busy === "verify" ? "Checking…" : domain.lastCheckedAt ? "Verify again" : "Verify DNS"}
            </button>
            {["AWAITING_DNS", "DNS_MISMATCH"].includes(domain.status) && (
              <button className="wlSecondary" type="button" disabled={busy !== null} onClick={() => void rotate()}>
                {busy === "rotate" ? "Rotating…" : "Rotate TXT proof"}
              </button>
            )}
            <button className="wlSecondary wlDangerText" type="button" disabled={busy !== null} onClick={() => void disconnect()}>
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function DnsRecord({ type, name, value, ok }: { type: string; name: string; value: string; ok: boolean }) {
  return (
    <div className="wlDnsRecord">
      <span className="wlDnsType">{type}</span>
      <span><small>Name / Host</small><code>{name}</code></span>
      <span><small>Value</small><code>{value}</code></span>
      <b>{ok ? "✓" : "Pending"}</b>
    </div>
  );
}
