"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ManagedAgencyWorkspace } from "./workspace-access-panel";

type CreditPack = { code: string; name: string; credits: number; amountCents: number; currency: string };
type Allocation = { id: string; workspaceId: string; workspaceName: string; amount: number; createdAt: string };
type PoolData = {
  balance: number;
  allocations: Allocation[];
  packs: CreditPack[];
};
type ApiError = { error?: { message?: string } };
function message(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload) {
    const detail = (payload as ApiError).error?.message;
    if (detail) return detail;
  }
  return fallback;
}
function n(value: number) { return new Intl.NumberFormat().format(value); }
function price(pack: CreditPack) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: pack.currency.toUpperCase() })
    .format(pack.amountCents / 100);
}

export function AgencyCreditPanel({ workspaces }: { workspaces: ManagedAgencyWorkspace[] }) {
  const [data, setData] = useState<PoolData | null>(null);
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Keep the same key across network retries; reset only when the intended
  // recipient/amount changes or a transfer is confirmed.
  const allocationKey = useRef<string | null>(null);

  const clients = workspaces.filter((workspace) => workspace.kind === "ADDITIONAL" && workspace.workspaceStatus === "ACTIVE");
  const parsedAmount = Number(amount);
  const validAmount = Number.isSafeInteger(parsedAmount) && parsedAmount > 0 && parsedAmount <= 1_000_000_000;
  const canAllocate = Boolean(data && target && validAmount && parsedAmount <= data.balance);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("checkout") === "success") {
      setNotice("Payment received. The Agency pool updates after the verified payment webhook.");
    } else if (query.get("checkout") === "cancelled") {
      setNotice("Checkout cancelled. Your Agency pool was not charged.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetch("/api/agency/credits", { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(message(payload, "Unable to load Agency credits."));
      if (!controller.signal.aborted) setData(payload as PoolData);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load Agency credits.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [reload]);

  async function buy(packCode: string) {
    if (busy) return;
    setBusy(packCode);
    setError(null);
    try {
      const response = await fetch("/api/agency/credits/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packCode }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("url" in payload) || typeof payload.url !== "string") {
        throw new Error(message(payload, "Unable to start Agency credit checkout."));
      }
      window.location.assign(payload.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to start Agency credit checkout.");
      setBusy(null);
    }
  }

  async function allocate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canAllocate) return;
    if (!allocationKey.current) allocationKey.current = crypto.randomUUID();
    setBusy("allocation");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/agency/credits/allocations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: target, amount: parsedAmount, idempotencyKey: allocationKey.current }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(message(payload, "Unable to allocate credits."));
      setNotice(`${n(parsedAmount)} credits allocated to ${clients.find((w) => w.workspaceId === target)?.workspaceName ?? "client"}.`);
      allocationKey.current = null;
      setAmount("");
      setReload((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to allocate credits.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="agencyCreditCard" aria-label="Agency credit pool">
      <div className="agencyCreditHeader">
        <div>
          <p className="agencyEyebrow">Agency credit distribution</p>
          <h2>Credit pool</h2>
          <p>Buy credits for your Agency, then allocate them to client workspaces. Clients cannot purchase platform credits directly.</p>
        </div>
        <div className="agencyCreditBalance">
          <span>Available to allocate</span>
          <strong>{loading ? "—" : n(data?.balance ?? 0)}</strong>
          <button type="button" className="agencySecondaryButton" disabled={loading || busy !== null}
            onClick={() => setReload((value) => value + 1)}>Refresh balance</button>
        </div>
      </div>
      {error && <div className="agencyActionError" role="alert">{error}</div>}
      {notice && <p className="agencyCreditNotice" role="status">{notice}</p>}

      <div className="agencyCreditSection">
        <h3>Buy Agency credits</h3>
        <p>One-time Stripe checkout. Credit top-ups are final and non-refundable under the purchase policy.</p>
        <div className="agencyCreditPacks">
          {(data?.packs ?? []).map((pack) => (
            <div className="agencyCreditPack" key={pack.code}>
              <strong>{n(pack.credits)} credits</strong>
              <span>{price(pack)}</span>
              <button type="button" className="agencyCreateButton" disabled={busy !== null} onClick={() => void buy(pack.code)}>
                {busy === pack.code ? "Opening…" : "Buy for Agency"}
              </button>
            </div>
          ))}
          {!loading && !data?.packs.length && <p>No credit packs are currently available.</p>}
        </div>
      </div>

      <form className="agencyCreditSection" onSubmit={(event) => void allocate(event)}>
        <h3>Allocate credits to a client</h3>
        <p>Credits transfer from your Agency pool into the selected client's isolated usage wallet.</p>
        <div className="agencyCreditFields">
          <label htmlFor="agency-credit-client">Client workspace</label>
          <select id="agency-credit-client" required value={target} disabled={busy !== null}
            onChange={(event) => { setTarget(event.target.value); allocationKey.current = null; }}>
            <option value="">Choose a client</option>
            {clients.map((client) => <option key={client.workspaceId} value={client.workspaceId}>{client.workspaceName}</option>)}
          </select>
          <label htmlFor="agency-credit-amount">Credits</label>
          <input id="agency-credit-amount" type="number" required min={1} max={1_000_000_000}
            step={1} value={amount} disabled={busy !== null} placeholder="e.g. 10000"
            onChange={(event) => { setAmount(event.target.value); allocationKey.current = null; }} />
          <button type="submit" className="agencyCreateButton" disabled={busy !== null || !canAllocate}>
            {busy === "allocation" ? "Allocating…" : "Allocate credits"}
          </button>
        </div>
        {validAmount && data && target && (
          <p className="agencyCreditPreview">
            Agency pool: {n(data.balance)} → {n(data.balance - parsedAmount)} credits
          </p>
        )}
      </form>

      <div className="agencyCreditSection">
        <h3>Recent allocations</h3>
        {!loading && !data?.allocations.length && <p>No credits have been allocated yet.</p>}
        {(data?.allocations ?? []).map((item) => (
          <div className="agencyCreditActivity" key={item.id}>
            <span>{item.workspaceName}</span>
            <strong>+{n(item.amount)}</strong>
            <small>{new Date(item.createdAt).toLocaleDateString()}</small>
          </div>
        ))}
      </div>
    </section>
  );
}
