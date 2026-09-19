"use client";
import { useEffect, useState } from "react";
import "./contact-sms-consent.css";

type ConsentStatus = "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";
type ConsentCategory = "TRANSACTIONAL" | "MARKETING";

export function ContactSmsConsent({ contactId, phone }: { contactId: string; phone: string | null }) {
  const [states, setStates] = useState<{ transactional: ConsentStatus; marketing: ConsentStatus }>({
    transactional: "UNKNOWN", marketing: "UNKNOWN",
  });
  const [category, setCategory] = useState<ConsentCategory>("TRANSACTIONAL");
  const [status, setStatus] = useState<"OPTED_IN" | "OPTED_OUT">("OPTED_IN");
  const [statement, setStatement] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setStates({ transactional: "UNKNOWN", marketing: "UNKNOWN" }); setNotice("");
    void fetch("/api/contacts/" + contactId + "/sms-consent", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (!cancelled && data) setStates({ transactional: data.transactional, marketing: data.marketing }); })
      .catch(() => { if (!cancelled) setNotice("Consent history could not be loaded."); });
    return () => { cancelled = true; };
  }, [contactId]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!phone) return;
    setSaving(true); setNotice("");
    try {
      const response = await fetch("/api/contacts/" + contactId + "/sms-consent", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone, category, status, consentStatement: statement }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Unable to save SMS preference.");
      setStates((current) => ({ ...current, [category === "TRANSACTIONAL" ? "transactional" : "marketing"]: status }));
      setStatement("");
      setNotice("SMS consent evidence saved.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to save preference."); }
    finally { setSaving(false); }
  }
  return <section className="drawerSection contactSmsConsent">
    <h3>SMS permissions</h3>
    <p>Appointment updates: <strong>{states.transactional.replaceAll("_", " ")}</strong></p>
    <p>Marketing: <strong>{states.marketing.replaceAll("_", " ")}</strong></p>
    {phone ? <form onSubmit={(event) => void save(event)}>
      <label>Messaging program<select value={category} onChange={(event) => setCategory(event.target.value as ConsentCategory)}>
        <option value="TRANSACTIONAL">Appointment and service updates</option><option value="MARKETING">Marketing and offers</option>
      </select></label>
      <label>Customer preference<select value={status} onChange={(event) => setStatus(event.target.value as "OPTED_IN" | "OPTED_OUT")}>
        <option value="OPTED_IN">Customer explicitly opted in</option><option value="OPTED_OUT">Customer opted out</option>
      </select></label>
      <label>Evidence<textarea required={status === "OPTED_IN"} minLength={status === "OPTED_IN" ? 15 : 0}
        maxLength={2000} rows={3} value={statement} onChange={(event) => setStatement(event.target.value)}
        placeholder="When and how did the customer agree? Capture their exact consent and what the program covers." /></label>
      <small>Do not mark a contact opted in solely because they were imported, called, or booked.</small>
      <button type="submit" disabled={saving || (status === "OPTED_IN" && statement.trim().length < 15)}>
        {saving ? "Saving…" : "Record preference"}</button>
    </form> : <p>Save a valid US phone number before recording SMS permission.</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
