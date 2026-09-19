"use client";
import { useEffect, useState } from "react";
import "./sms-registration-settings.css";

type Draft = {
  legalName: string; contactName: string; contactEmail: string; contactPhone: string;
  website: string; privacyPolicyUrl: string; termsUrl: string; messagingUseCase: string;
  optInFlow: string; sampleMessages: string[]; categories: Array<"TRANSACTIONAL" | "MARKETING">;
  allowEmbeddedLinks: boolean;
  businessAddress: string; businessCity: string; businessState: string; businessZip: string;
  entityType: "PRIVATE_PROFIT" | "PUBLIC_PROFIT" | "NON_PROFIT" | "GOVERNMENT" | "SOLE_PROPRIETOR";
  vertical: string; ein: string; messageVolume: string; optInEvidenceUrl: string;
};
const initial: Draft = {
  legalName: "", contactName: "", contactEmail: "", contactPhone: "", website: "",
  privacyPolicyUrl: "", termsUrl: "", messagingUseCase: "", optInFlow: "",
  sampleMessages: ["", ""], categories: ["TRANSACTIONAL"], allowEmbeddedLinks: true,
  businessAddress: "", businessCity: "", businessState: "", businessZip: "",
  entityType: "PRIVATE_PROFIT", vertical: "PROFESSIONAL", ein: "", messageVolume: "1,000", optInEvidenceUrl: "",
};

export function SmsRegistrationSettings() {
  const [number, setNumber] = useState<{ phoneNumber: string; numberType: string; messagingReadiness: string } | null>(null);
  const [draft, setDraft] = useState<Draft>(initial);
  const [status, setStatus] = useState("NOT_STARTED");
  const [rejection, setRejection] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/sms/registration", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("SMS registration details are unavailable for this account.");
      return response.json();
    }).then((data) => {
      if (cancelled) return;
      setNumber(data.number ?? null);
      setStatus(data.registration?.status ?? "NOT_STARTED");
      setRejection(data.registration?.rejectionReason ?? null);
      setDraft({
        ...initial,
        legalName: data.business?.businessName ?? "",
        website: data.business?.website ?? "",
        contactPhone: data.business?.phone ?? "",
        businessAddress: data.business?.address ?? "",
        businessCity: data.business?.city ?? "",
        businessState: (data.business?.state ?? "").toUpperCase(),
        businessZip: data.business?.postalCode ?? "",
        ...(data.registration?.draft ?? {}),
      });
    }).catch((error) => { if (!cancelled) setNotice(error instanceof Error ? error.message : "Unable to load registration."); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  async function submitRegistration() {
    setSubmitting(true); setNotice("");
    try {
      const response = await fetch("/api/sms/registration", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Unable to submit to carrier.");
      setStatus(data.status);
      setNotice("Submission received. Carrier approval and number assignment must finish before outbound SMS is enabled.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Carrier submission status is uncertain.");
    } finally { setSubmitting(false); }
  }

  function field<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch("/api/sms/registration", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Unable to save registration details.");
      setStatus(data.registration.status);
      setNotice("Draft saved. Review the information and submit for carrier approval.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to save registration.");
    } finally { setSaving(false); }
  }

  return <section className="smsRegistrationPanel" id="sms-registration">
    <h2>SMS registration</h2>
    {!loaded && <p>Loading registration…</p>}
    {loaded && !number && <p>Activate a US managed phone number to prepare your optional SMS registration. Calls and other available capabilities are independent of SMS approval.</p>}
    {number && <>
      <p>Register {number.phoneNumber} for {number.numberType === "toll_free" ? "toll-free messaging verification" : "US 10DLC messaging"}. You can continue using available phone capabilities while registration is unfinished.</p>
      <p className="smsRegistrationStatus">Outbound SMS: <strong>{number.messagingReadiness.replaceAll("_", " ")}</strong> · Registration: <strong>{status.replaceAll("_", " ")}</strong></p>
      {rejection && <p role="alert">Carrier response: {rejection}</p>}
      {status === "READY" ? <p>Carrier approval is recorded. Your number's readiness status controls outbound SMS.</p> :
      ["PENDING","SUBMITTING"].includes(status) ? <p>Your submission is being reviewed. Registration details are locked until a carrier response arrives.</p> :
      <form onSubmit={(event) => void save(event)}>
        <div className="smsRegistrationGrid">
          <label>Legal business name<input required minLength={2} maxLength={200} value={draft.legalName} onChange={(e) => field("legalName", e.target.value)} /></label>
          <label>Contact full name<input required minLength={2} value={draft.contactName} onChange={(e) => field("contactName", e.target.value)} /></label>
          <label>Contact email<input required type="email" value={draft.contactEmail} onChange={(e) => field("contactEmail", e.target.value)} /></label>
          <label>Contact phone<input required value={draft.contactPhone} onChange={(e) => field("contactPhone", e.target.value)} /></label>
          <label>Business website<input required type="url" value={draft.website} onChange={(e) => field("website", e.target.value)} /></label>
          <label>Privacy policy URL<input required type="url" value={draft.privacyPolicyUrl} onChange={(e) => field("privacyPolicyUrl", e.target.value)} /></label>
          <label>SMS terms URL<input required type="url" value={draft.termsUrl} onChange={(e) => field("termsUrl", e.target.value)} /></label>
          <label>Street address<input required value={draft.businessAddress} onChange={(e) => field("businessAddress", e.target.value)} /></label>
          <label>City<input required value={draft.businessCity} onChange={(e) => field("businessCity", e.target.value)} /></label>
          <label>State (two-letter code)<input required maxLength={2} value={draft.businessState} onChange={(e) => field("businessState", e.target.value.toUpperCase())} /></label>
          <label>ZIP code<input required value={draft.businessZip} onChange={(e) => field("businessZip", e.target.value)} /></label>
          <label>Business type<select value={draft.entityType} onChange={(e) => field("entityType", e.target.value as Draft["entityType"])}>
            <option value="PRIVATE_PROFIT">Private company</option><option value="PUBLIC_PROFIT">Public company</option>
            <option value="NON_PROFIT">Nonprofit</option><option value="GOVERNMENT">Government</option>
            <option value="SOLE_PROPRIETOR">Sole proprietor</option></select></label>
          <label>Business industry<select value={draft.vertical} onChange={(e) => field("vertical", e.target.value)}>
            {["PROFESSIONAL","HEALTHCARE","RETAIL","TECHNOLOGY","HOSPITALITY","EDUCATION","LEGAL","REAL_ESTATE","FINANCIAL","CONSTRUCTION","MANUFACTURING","TRANSPORTATION","ENTERTAINMENT","INSURANCE"].map((v) => <option key={v} value={v}>{v.replaceAll("_"," ")}</option>)}
          </select></label>
          <label>Business tax ID (EIN)<input value={draft.ein} onChange={(e) => field("ein", e.target.value)} required={draft.entityType !== "SOLE_PROPRIETOR" && number.numberType === "local"} /></label>
          <label>Estimated monthly SMS volume<select value={draft.messageVolume} onChange={(e) => field("messageVolume", e.target.value)}>
            {["10","100","1,000","10,000","100,000","250,000","500,000","750,000","1,000,000","5,000,000","10,000,000+"].map((v) => <option key={v} value={v}>{v}</option>)}
          </select></label>
          <label>Public opt-in form or screenshot URL<input type="url" required value={draft.optInEvidenceUrl} onChange={(e) => field("optInEvidenceUrl", e.target.value)} /></label>
        </div>
        <label>Messaging use case<textarea required minLength={30} maxLength={3000} rows={3} placeholder="e.g. Appointment confirmations, reminders and rescheduling updates" value={draft.messagingUseCase} onChange={(e) => field("messagingUseCase", e.target.value)} /></label>
        <label>How customers opt in<textarea required minLength={30} maxLength={3000} rows={3} placeholder="Describe website consent, inbound text and verbal opt-in flows" value={draft.optInFlow} onChange={(e) => field("optInFlow", e.target.value)} /></label>
        {draft.sampleMessages.map((example, i) => <label key={i}>Example message {i + 1}<textarea required minLength={10} rows={2} value={example} onChange={(e) => field("sampleMessages", draft.sampleMessages.map((item, j) => j === i ? e.target.value : item))} /></label>)}
        <div className="smsRegistrationChoices">
          <label><input type="checkbox" checked={draft.categories.includes("TRANSACTIONAL")} onChange={(e) => field("categories", e.target.checked ? [...draft.categories, "TRANSACTIONAL"] : draft.categories.filter((c) => c !== "TRANSACTIONAL"))} /> Transactional appointment / service updates</label>
          <label><input type="checkbox" checked={draft.categories.includes("MARKETING")} onChange={(e) => field("categories", e.target.checked ? [...draft.categories, "MARKETING"] : draft.categories.filter((c) => c !== "MARKETING"))} /> Marketing communications</label>
          <label><input type="checkbox" checked={draft.allowEmbeddedLinks} onChange={(e) => field("allowEmbeddedLinks", e.target.checked)} /> Messages may include booking or other relevant links</label>
        </div>
        <button type="submit" disabled={saving || !draft.categories.length}>{saving ? "Saving…" : "Save registration draft"}</button>
      </form>}
    </>}
    {number && status === "DRAFT" && <button type="button" className="smsRegistrationSubmit" disabled={submitting || saving} onClick={() => void submitRegistration()}>{submitting ? "Submitting…" : "Submit for carrier approval"}</button>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
