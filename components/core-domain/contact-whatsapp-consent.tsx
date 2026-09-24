"use client";
import { useEffect, useState } from "react";
import "./contact-sms-consent.css";

type ConsentStatus = "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";
type Item = { waId: string; utility: ConsentStatus; marketing: ConsentStatus };

export function ContactWhatsAppConsent({ contactId, waIds }: {
  contactId: string;
  waIds: string[];
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState("");
  const [category, setCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [status, setStatus] = useState<"OPTED_IN" | "OPTED_OUT">("OPTED_IN");
  const [statement, setStatement] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setItems([]); setSelected(""); setNotice("");
    void fetch(`/api/contacts/${contactId}/whatsapp-consent`, { cache: "no-store" })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message ?? "WhatsApp preferences could not load.");
        return data as { items: Item[] };
      })
      .then(data => { if (!cancelled) {
        setItems(data.items); setSelected(data.items[0]?.waId ?? "");
      } })
      .catch(error => { if (!cancelled) setNotice(error instanceof Error ? error.message : "Unable to load preferences."); });
    return () => { cancelled = true; };
  }, [contactId]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setNotice("");
    try {
      const response = await fetch(`/api/contacts/${contactId}/whatsapp-consent`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ waId: selected, category, status, consentStatement: statement }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Unable to save WhatsApp permission.");
      setItems(current => current.map(item => item.waId === selected
        ? { ...item, [category === "UTILITY" ? "utility" : "marketing"]: status } : item));
      setStatement(""); setNotice("WhatsApp preference saved.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to save preference."); }
    finally { setSaving(false); }
  }
  const current = items.find(item => item.waId === selected);
  return <section className="drawerSection contactSmsConsent">
    <h3>WhatsApp permissions</h3>
    {waIds.length ? <>
      {items.length > 1 && <label>WhatsApp identity<select value={selected}
        onChange={event => setSelected(event.target.value)}>
        {items.map(item => <option key={item.waId} value={item.waId}>{item.waId}</option>)}
      </select></label>}
      <p>Service updates: <strong>{current?.utility.replaceAll("_", " ") ?? "UNKNOWN"}</strong></p>
      <p>Marketing: <strong>{current?.marketing.replaceAll("_", " ") ?? "UNKNOWN"}</strong></p>
      <form onSubmit={(event) => void save(event)}>
        <label>Message type<select value={category}
          onChange={event => setCategory(event.target.value as "UTILITY" | "MARKETING")}>
          <option value="UTILITY">Appointment and service updates</option>
          <option value="MARKETING">Marketing and offers</option>
        </select></label>
        <label>Customer preference<select value={status}
          onChange={event => setStatus(event.target.value as "OPTED_IN" | "OPTED_OUT")}>
          <option value="OPTED_IN">Customer explicitly opted in</option>
          <option value="OPTED_OUT">Customer opted out</option>
        </select></label>
        <label>Evidence<textarea required={status === "OPTED_IN"}
          minLength={status === "OPTED_IN" ? 15 : 0} maxLength={2000}
          rows={3} value={statement} onChange={event => setStatement(event.target.value)}
          placeholder="When and how did the customer consent to this WhatsApp message type?" /></label>
        <small>SMS opt-in does not grant WhatsApp permission. START resumes service updates, not marketing.</small>
        <button type="submit" disabled={!selected || saving || (status === "OPTED_IN" && statement.trim().length < 15)}>
          {saving ? "Saving…" : "Record WhatsApp preference"}</button>
      </form>
    </> : <p>Link a WhatsApp identity before recording WhatsApp permission.</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
