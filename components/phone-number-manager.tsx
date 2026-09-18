"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckIcon, PhoneIcon } from "@/components/icons";
import { showToast } from "@/components/toast";
import styles from "./phone-number-manager.module.css";

type SearchResult = {
  phoneNumber: string;
  countryCode: string;
  administrativeArea: string | null;
  locality: string | null;
  numberType: string;
  monthlyCredits: number;
  purchaseCredits: number;
};

export type ManagedPhoneNumber = {
  id: string;
  phoneNumber: string;
  countryCode: string;
  administrativeArea: string | null;
  locality: string | null;
  numberType: string;
  status: string;
  messagingReadiness: "NOT_REGISTERED" | "PENDING" | "READY" | "REJECTED";
  monthlyCredits?: number;
  purchaseCredits?: number;
  currentPeriodEnd?: string | null;
  nextBillingAt?: string | null;
  graceEndsAt?: string | null;
  failureReason: string | null;
};

const US_STATES = [
  ["", "Any state"], ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["FL", "Florida"],
  ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"],
  ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"],
  ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"],
  ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"],
  ["WY", "Wyoming"], ["DC", "District of Columbia"],
] as const;

function formatNumber(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return value;
}

function statusLabel(status: string) {
  if (status === "ACTIVE") return "Active";
  if (status === "PAST_DUE") return "Renewal past due";
  if (status === "SUSPENDED") return "Service suspended";
  if (status === "PROVISIONING") return "Provisioning";
  if (status === "RECONCILING") return "Confirming with carrier";
  return status.replaceAll("_", " ").toLowerCase();
}

function apiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : fallback;
}

export function PhoneNumberManager({
  onNumberChange,
  settingsMode = false,
}: {
  onNumberChange?: (number: ManagedPhoneNumber | null) => void;
  settingsMode?: boolean;
}) {
  const [current, setCurrent] = useState<ManagedPhoneNumber | null>(null);
  const [creditBalance, setCreditBalance] = useState(0);
  const [canManage, setCanManage] = useState(false);
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [areaCode, setAreaCode] = useState("");
  const [numberType, setNumberType] = useState<"local" | "toll_free">("local");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [changing, setChanging] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function loadCurrent() {
    const response = await fetch("/api/phone-numbers", { cache: "no-store" });
    const payload = await response.json().catch(() => null) as { number?: ManagedPhoneNumber | null; creditBalance?: number; canManage?: boolean; error?: { message?: string } } | null;
    if (!response.ok) throw new Error(apiError(payload, "Unable to load your business phone number."));
    const number = payload?.number ?? null;
    setCurrent(number);
    setCreditBalance(payload?.creditBalance ?? 0);
    setCanManage(payload?.canManage === true);
    onNumberChange?.(number);
  }

  useEffect(() => {
    void loadCurrent()
      .catch((error) => showToast(error instanceof Error ? error.message : "Unable to load your business phone number.", "error"))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (current?.status !== "PROVISIONING" && current?.status !== "RECONCILING") return;
    const timer = window.setInterval(() => {
      void loadCurrent().catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [current?.status]);

  const insufficient = useMemo(() => Boolean(selected && selected.purchaseCredits > creditBalance), [selected, creditBalance]);

  async function search() {
    setSearching(true);
    setSelected(null);
    try {
      const params = new URLSearchParams({ country: "US", type: numberType });
      if (state) params.set("state", state);
      if (city.trim()) params.set("city", city.trim());
      if (areaCode.trim()) params.set("areaCode", areaCode.trim());
      const response = await fetch("/api/phone-numbers/search?" + params.toString(), { cache: "no-store" });
      const payload = await response.json().catch(() => null) as { items?: SearchResult[]; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(apiError(payload, "Unable to search available phone numbers."));
      const items = payload?.items ?? [];
      setResults(items);
      if (!items.length) showToast("No matching numbers were found. Try a nearby city, state, or area code.", "info");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to search available phone numbers.", "error");
    } finally {
      setSearching(false);
    }
  }

  async function provision() {
    if (!selected || provisioning) return;
    if (insufficient) {
      showToast(`This number requires ${selected.purchaseCredits.toLocaleString()} credits. Top up your balance before selecting it.`, "error");
      return;
    }
    if (current && !window.confirm("Changing your number releases the old number after the new one is active. Continue?")) return;

    setProvisioning(true);
    try {
      const response = await fetch("/api/phone-numbers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phoneNumber: selected.phoneNumber,
          requestId: crypto.randomUUID(),
          replaceCurrent: Boolean(current),
        }),
      });
      const payload = await response.json().catch(() => null) as { number?: ManagedPhoneNumber; error?: { message?: string } } | null;
      if (!response.ok || !payload?.number) throw new Error(apiError(payload, "Unable to activate that phone number."));
      setCurrent(payload.number);
      onNumberChange?.(payload.number);
      setChanging(false);
      setResults([]);
      setSelected(null);
      await loadCurrent();
      if (payload.number.status === "ACTIVE") {
        showToast(
          payload.number.messagingReadiness === "READY"
            ? "Your phone number is active for calls and outbound SMS."
            : "Your phone number is active for calls. Outbound SMS will unlock after carrier registration is approved.",
          "success",
        );
      } else {
        showToast("Your number order was accepted. AI Caller is waiting for the carrier to finish activation.", "info");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to activate that phone number.", "error");
    } finally {
      setProvisioning(false);
    }
  }

  if (!loaded) return <div className={styles.loading}>Loading phone number settings…</div>;

  if (current && !changing) {
    const attention = current.status === "PAST_DUE" || current.status === "SUSPENDED" || current.status === "PROVISIONING" || current.status === "RECONCILING";
    const phoneOperational = current.status === "ACTIVE" || current.status === "PAST_DUE";
    const smsReady = current.messagingReadiness === "READY";
    return (
      <div className={styles.currentWrap}>
        <div className={styles.currentCard}>
          <span className={styles.currentIcon}><PhoneIcon size={22} /></span>
          <div className={styles.currentIdentity}>
            <small>Your business number</small>
            <strong>{formatNumber(current.phoneNumber)}</strong>
            <span>{[current.locality, current.administrativeArea].filter(Boolean).join(", ") || "United States"} · Managed voice + SMS-capable number</span>
          </div>
          <span className={attention ? styles.statusWarn : styles.statusOk}>{statusLabel(current.status)}</span>
        </div>

        {attention && (
          <div className={styles.warning}>
            <strong>{
              current.status === "SUSPENDED" ? "Phone service is suspended"
                : current.status === "PAST_DUE" ? "Renewal needs more credits"
                  : current.status === "RECONCILING" ? "Confirming carrier purchase"
                    : "Carrier activation in progress"
            }</strong>
            <span>{current.failureReason ?? (current.status === "PAST_DUE" || current.status === "SUSPENDED" ? "Add credits to renew this number." : "AI Caller is waiting for the carrier to finish activating this number.")}</span>
            {canManage && (current.status === "PAST_DUE" || current.status === "SUSPENDED") && <a href="/settings/billing">Top up credits</a>}
          </div>
        )}

        <div className={styles.billingRow}>
          {canManage && <div><span>Monthly renewal</span><strong>{(current.monthlyCredits ?? 0).toLocaleString()} credits</strong></div>}
          {canManage && <div><span>Next billing</span><strong>{current.nextBillingAt ? new Date(current.nextBillingAt).toLocaleDateString() : "Pending"}</strong></div>}
          <div><span>Calls</span><strong>{phoneOperational ? "Active" : "Pending carrier activation"}</strong></div>
          <div><span>Outbound SMS</span><strong>{smsReady ? "Ready" : current.messagingReadiness === "REJECTED" ? "Registration rejected" : current.messagingReadiness === "PENDING" ? "Registration pending" : "Registration required"}</strong></div>
          {canManage && <button type="button" onClick={() => setChanging(true)}>{settingsMode ? "Change number" : "Choose a different number"}</button>}
        </div>
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className={styles.manager}>
        <div className={styles.autoNote}>
          <CheckIcon size={16} />
          <span><strong>Workspace owner action required.</strong> Only the workspace owner can choose a managed number or incur recurring telephony charges.</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.manager}>
      {current && changing && <button className={styles.cancelChange} type="button" onClick={() => setChanging(false)}>← Keep current number</button>}
      <div className={styles.heading}>
        <span><PhoneIcon size={22} /></span>
        <div><strong>Choose your phone number</strong><p>Find a voice + SMS-capable number. AI Caller configures carrier routing automatically; outbound US business SMS may require registration before sending.</p></div>
      </div>

      <div className={styles.filters}>
        <label><span>Country</span><select disabled value="US"><option value="US">United States</option></select></label>
        <label><span>State / area</span><select value={state} onChange={(event) => setState(event.target.value)}>{US_STATES.map(([code, name]) => <option value={code} key={code || "any"}>{name}{code ? ` (${code})` : ""}</option>)}</select></label>
        <label><span>City <em>optional</em></span><input value={city} onChange={(event) => setCity(event.target.value)} placeholder="Sheridan" /></label>
        <label><span>Area code <em>optional</em></span><input inputMode="numeric" maxLength={3} value={areaCode} onChange={(event) => setAreaCode(event.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="307" /></label>
        <label><span>Number type</span><select value={numberType} onChange={(event) => setNumberType(event.target.value as "local" | "toll_free")}><option value="local">Local</option><option value="toll_free">Toll-free</option></select></label>
        <button className={styles.searchButton} type="button" disabled={searching} onClick={() => void search()}>{searching ? "Searching…" : "Search numbers"}</button>
      </div>

      {results.length > 0 && (
        <div className={styles.results}>
          <div className={styles.resultHeader}><span>Available numbers</span><small>{results.length} matches · voice + SMS capable</small></div>
          {results.map((item) => {
            const active = selected?.phoneNumber === item.phoneNumber;
            return (
              <button className={active ? styles.resultSelected : styles.result} type="button" key={item.phoneNumber} onClick={() => setSelected(item)}>
                <i className={styles.radio}>{active && <b />}</i>
                <strong>{formatNumber(item.phoneNumber)}</strong>
                <span>{[item.locality, item.administrativeArea].filter(Boolean).join(", ") || "United States"}</span>
                <span className={styles.feature}><CheckIcon size={13} /> Calls</span>
                <span className={styles.feature}><CheckIcon size={13} /> SMS</span>
                <b>{item.monthlyCredits.toLocaleString()} credits/mo</b>
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <div className={styles.selection}>
          <div>
            <span>Selected number</span>
            <strong>{formatNumber(selected.phoneNumber)}</strong>
            <small>{selected.purchaseCredits.toLocaleString()} credits today · then {selected.monthlyCredits.toLocaleString()} credits/month</small>
          </div>
          <div className={styles.balance}><span>Credit balance</span><strong>{creditBalance.toLocaleString()}</strong></div>
          <button type="button" disabled={provisioning || insufficient} onClick={() => void provision()}>{provisioning ? "Activating…" : current ? "Change to this number" : "Use this number"}</button>
          {insufficient && <a href="/settings/billing">Top up credits</a>}
        </div>
      )}

      <div className={styles.autoNote}>
        <CheckIcon size={16} />
        <span><strong>Carrier routing is handled for you.</strong> AI Caller configures voice, inbound SMS routing and webhooks automatically. Outbound SMS stays disabled until the required carrier registration is approved. Number renewal is billed from your AI Caller credits.</span>
      </div>
    </div>
  );
}
