"use client";
import { useState } from "react";
import "./hosted-sms-optin-form.css";

export function HostedSmsOptinForm({ widgetKey, businessName, termsUrl, marketingAllowed }: {
  widgetKey: string; businessName: string; termsUrl: string; marketingAllowed: boolean;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [transactional, setTransactional] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const key = "ai-caller:session:" + widgetKey;
      const existing = localStorage.getItem(key);
      const sessionResponse = await fetch("/api/widget/session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ widgetKey, sessionToken: existing ?? undefined }),
      });
      const session = await sessionResponse.json();
      if (!sessionResponse.ok) throw new Error(session.error?.message ?? "Unable to start contact registration.");
      localStorage.setItem(key, session.sessionToken);
      const response = await fetch("/api/widget/contact", {
        method: "POST", headers: { authorization: "Bearer " + session.sessionToken, "content-type": "application/json" },
        body: JSON.stringify({ name, email, phone, transactionalSmsConsent: transactional, marketingSmsConsent: marketing }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Unable to record your preferences.");
      setDone(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save your preferences."); }
    finally { setBusy(false); }
  }
  if (done) return <p role="status">Thank you. Your contact details and SMS preferences were saved.</p>;
  return <form className="hostedSmsOptin" onSubmit={(event) => void submit(event)}>
    <label>Name<input required autoComplete="name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label>Email<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label>Phone number<input required type="tel" autoComplete="tel" placeholder="+1 202 555 0100" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
    <label className="hostedSmsCheck"><input type="checkbox" checked={transactional} onChange={(e) => setTransactional(e.target.checked)} />
      I agree to receive appointment confirmations, reminders, and service-related text updates from {businessName}.
    </label>
    {marketingAllowed && <label className="hostedSmsCheck"><input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
      I separately agree to receive promotional texts and offers from {businessName}.
    </label>}
    <p>Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out or HELP for help. <a href={termsUrl} target="_blank" rel="noopener noreferrer">Our SMS Terms &amp; Policy</a>.</p>
    {error && <p role="alert">{error}</p>}
    <button type="submit" disabled={busy || (!transactional && !marketing)}>{busy ? "Saving…" : "Save SMS preferences"}</button>
  </form>;
}
