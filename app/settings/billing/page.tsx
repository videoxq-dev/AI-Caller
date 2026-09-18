"use client";

import { useEffect, useMemo, useState } from "react";
import { AppNav } from "@/components/core-domain/app-nav";
import "@/app/dashboard/dashboard.css";
import "./billing.css";

type Plan = {
  id: string;
  name: string;
  description: string | null;
  subUserLimit: number;
};

type CreditPack = {
  code: string;
  name: string;
  credits: number;
  amountCents: number;
  currency: string;
};

type LedgerItem = {
  id: string;
  type: "GRANT" | "PURCHASE" | "DEBIT" | "REFUND" | "ADJUSTMENT";
  amount: number;
  balanceAfter: number;
  reason: string;
  createdAt: string;
};

type Topup = {
  id: string;
  packCode: string;
  credits: number;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
  paidAt: string | null;
};

type Usage = {
  id: string;
  capability: "AI_TEXT" | "SMS" | "VOICE" | "WHATSAPP" | "CALENDAR";
  provider: string;
  mode: "HOSTED" | "BYOP";
  creditsCharged: number;
  createdAt: string;
};

type BillingData = {
  workspace: { id: string; name: string };
  plan: Plan;
  balance: number;
  packs: CreditPack[];
  ledger: LedgerItem[];
  topups: Topup[];
  usage: Usage[];
};

function number(value: number) {
  return new Intl.NumberFormat().format(value);
}

function money(cents: number, currency = "usd") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function date(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function statusLabel(status: string) {
  return status.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export default function BillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/billing", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as BillingData | { error?: { message?: string } } | null;
      if (!response.ok) {
        const message = payload && "error" in payload ? payload.error?.message : null;
        throw new Error(message || "Unable to load billing.");
      }
      setData(payload as BillingData);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load billing.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("checkout") === "success") setNotice("Payment received by Stripe. Credits will appear after the signed payment webhook is processed.");
    if (query.get("checkout") === "cancelled") setNotice("Checkout was cancelled. No credits were purchased.");
    void load();
  }, []);

  const hostedUsage = useMemo(
    () => (data?.usage ?? []).filter((item) => item.mode === "HOSTED"),
    [data],
  );
  const creditsUsed = hostedUsage.reduce((sum, item) => sum + item.creditsCharged, 0);
  const paidTopups = (data?.topups ?? []).filter((item) => Boolean(item.paidAt)).length;
  const aiCredits = hostedUsage.filter((item) => item.capability === "AI_TEXT").reduce((sum, item) => sum + item.creditsCharged, 0);
  const smsCredits = hostedUsage.filter((item) => item.capability === "SMS").reduce((sum, item) => sum + item.creditsCharged, 0);

  async function buy(packCode: string) {
    if (buying) return;
    setBuying(packCode);
    setError(null);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packCode }),
      });
      const payload = await response.json().catch(() => null) as { url?: string; error?: { message?: string } } | null;
      if (!response.ok || !payload?.url) {
        throw new Error(payload?.error?.message || "Unable to start Stripe Checkout.");
      }
      window.location.assign(payload.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to start Stripe Checkout.");
      setBuying(null);
    }
  }

  return (
    <main className="appShell billingShell">
      <AppNav active="Settings" />
      <section className="appWorkspace billingWorkspace">
        <header className="billingTopbar">
          <div>
            <span className="billingEyebrow">Settings / Billing &amp; Usage</span>
            <h1>Billing &amp; Usage</h1>
            <p>Manage hosted credits, see metered usage, and review credit transactions.</p>
          </div>
          <button type="button" className="billingRefresh" onClick={() => void load()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </header>

        <div className="billingBody">
          {notice && <div className="billingNotice">{notice}</div>}
          {error && <div className="billingError" role="alert"><strong>Billing unavailable</strong><span>{error}</span></div>}

          <section className="billingSummaryGrid" aria-busy={loading}>
            <article className="billingCard balanceCard">
              <span className="billingCardLabel">Available credits</span>
              <strong>{number(data?.balance ?? 0)}</strong>
              <small>1,000 credits = $1 of customer value</small>
            </article>
            <article className="billingCard">
              <span className="billingCardLabel">Current plan</span>
              <strong className="billingPlanName">{data?.plan.name ?? "—"}</strong>
              <small>{data?.plan.subUserLimit ? `Up to ${data.plan.subUserLimit} sub-users` : "No sub-users"}</small>
            </article>
            <article className="billingCard">
              <span className="billingCardLabel">Hosted credits used</span>
              <strong>{number(creditsUsed)}</strong>
              <small>Across the most recent {data?.usage.length ?? 0} recorded usage events</small>
            </article>
            <article className="billingCard">
              <span className="billingCardLabel">Completed top-ups</span>
              <strong>{number(paidTopups)}</strong>
              <small>Verified Stripe payments credited to this workspace</small>
            </article>
          </section>

          <section className="billingSection">
            <div className="billingSectionHeading">
              <div><h2>Top up credits</h2><p>One-time payment through Stripe-hosted Checkout. Credits are granted only after a verified payment webhook.</p></div>
            </div>
            <div className="creditPackGrid">
              {(data?.packs ?? []).map((pack) => (
                <article className="creditPack" key={pack.code}>
                  <span>{money(pack.amountCents, pack.currency)}</span>
                  <strong>{number(pack.credits)}</strong>
                  <small>credits</small>
                  <button type="button" onClick={() => void buy(pack.code)} disabled={Boolean(buying)}>
                    {buying === pack.code ? "Opening Checkout…" : "Buy credits"}
                  </button>
                </article>
              ))}
              {!loading && !data?.packs.length && <div className="billingEmpty">No credit packs are currently available.</div>}
            </div>
          </section>

          <section className="billingUsageGrid">
            <article className="billingCard billingUsageCard">
              <div className="billingSectionHeading"><div><h2>Hosted usage</h2><p>Credits charged by capability.</p></div></div>
              <div className="usageSplit">
                <div><span>AI</span><strong>{number(aiCredits)}</strong><small>credits</small></div>
                <div><span>SMS</span><strong>{number(smsCredits)}</strong><small>credits</small></div>
                <div><span>Other hosted</span><strong>{number(Math.max(0, creditsUsed - aiCredits - smsCredits))}</strong><small>credits</small></div>
              </div>
            </article>
            <article className="billingCard billingPlanCard">
              <div className="billingSectionHeading"><div><h2>{data?.plan.name ?? "Plan"}</h2><p>{data?.plan.description || "Workspace entitlement plan."}</p></div></div>
              <ul>
                <li>All current MVP product features</li>
                <li>{data?.plan.subUserLimit ? `Owner + ${data.plan.subUserLimit} sub-users` : "Single owner; team invitations disabled"}</li>
                <li>Hosted APIs use the shared credit wallet</li>
                <li>BYOP provider usage does not consume hosted transport credits</li>
              </ul>
            </article>
          </section>

          <section className="billingSection">
            <div className="billingSectionHeading"><div><h2>Credit activity</h2><p>Purchases, debits, refunds, grants and administrative adjustments.</p></div></div>
            <div className="billingTableWrap">
              <table className="billingTable">
                <thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Amount</th><th>Balance after</th></tr></thead>
                <tbody>
                  {(data?.ledger ?? []).map((item) => (
                    <tr key={item.id}>
                      <td>{date(item.createdAt)}</td>
                      <td><span className={`ledgerType ${item.type.toLowerCase()}`}>{item.type}</span></td>
                      <td>{item.reason}</td>
                      <td className={item.amount >= 0 ? "positiveAmount" : "negativeAmount"}>{item.amount >= 0 ? "+" : ""}{number(item.amount)}</td>
                      <td>{number(item.balanceAfter)}</td>
                    </tr>
                  ))}
                  {!loading && !data?.ledger.length && <tr><td colSpan={5} className="billingEmpty">No credit activity yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="billingSection">
            <div className="billingSectionHeading"><div><h2>Top-up purchases</h2><p>Stripe Checkout and payment state for recent purchases.</p></div></div>
            <div className="billingTableWrap">
              <table className="billingTable">
                <thead><tr><th>Created</th><th>Credits</th><th>Amount</th><th>Status</th><th>Paid</th></tr></thead>
                <tbody>
                  {(data?.topups ?? []).map((item) => (
                    <tr key={item.id}>
                      <td>{date(item.createdAt)}</td>
                      <td>{number(item.credits)}</td>
                      <td>{money(item.amountCents, item.currency)}</td>
                      <td><span className="purchaseStatus">{statusLabel(item.status)}</span></td>
                      <td>{date(item.paidAt)}</td>
                    </tr>
                  ))}
                  {!loading && !data?.topups.length && <tr><td colSpan={5} className="billingEmpty">No top-up purchases yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
