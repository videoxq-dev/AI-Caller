"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  GearIcon,
  HelpIcon,
  InfoIcon,
  LockIcon,
  LogoMark,
  ShieldIcon,
} from "@/components/icons";
import { SetupProgressPanel } from "../setup-progress";
import "./shared.css";
import "./calendar.css";

type CalendarProvider = "google" | "outlook" | "calendly" | "calcom";
type IntegrationSummary = { provider: string; status: "CONNECTED" | "ERROR" | "DISCONNECTED" };

const providers: Array<{ id: CalendarProvider; name: string; subtitle: string; badge: string; tone: string }> = [
  { id: "google", name: "Google Calendar", subtitle: "Most popular", badge: "G", tone: "google" },
  { id: "outlook", name: "Microsoft Outlook", subtitle: "For Microsoft 365", badge: "O", tone: "outlook" },
  { id: "calendly", name: "Calendly", subtitle: "Event types and availability", badge: "C", tone: "calendly" },
  { id: "calcom", name: "Cal.com", subtitle: "Flexible scheduling", badge: "Cal", tone: "calcom" },
];

const weekDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export default function CalendarSetupPage() {
  const router = useRouter();
  const [provider, setProvider] = useState<CalendarProvider>("google");
  const [days, setDays] = useState<Record<string, boolean>>({ Mon: true, Tue: true, Wed: true, Thu: true, Fri: true, Sat: false, Sun: false });
  const [meetingDuration, setMeetingDuration] = useState(30);
  const [bufferBefore, setBufferBefore] = useState(15);
  const [bufferAfter, setBufferAfter] = useState(15);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [suggestAlternatives, setSuggestAlternatives] = useState(true);
  const [eventType, setEventType] = useState("");
  const [meetingLocation, setMeetingLocation] = useState("Use provider default");
  const [maxBookings, setMaxBookings] = useState(8);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [externalCalendarEnabled, setExternalCalendarEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const returnedProvider = providers.find((item) => item.id === params.get("provider"));
    if (returnedProvider) setProvider(returnedProvider.id);
    if (params.get("connection") === "connected") setNotice(`${returnedProvider?.name ?? "Calendar"} connected successfully.`);
    if (params.get("connection") === "error") setNotice(params.get("message") || "Calendar connection failed. Please try again.");

    Promise.all([
      fetch("/api/setup/calendar", { cache: "no-store" }).then((response) => response.ok ? response.json() : null),
      fetch("/api/integrations", { cache: "no-store" }).then((response) => response.ok ? response.json() : null),
    ]).then(([setupPayload, integrationPayload]) => {
      const saved = setupPayload?.settings;
      if (saved) {
        if (saved.provider && !returnedProvider) setProvider(saved.provider);
        if (saved.meetingDurationMinutes) setMeetingDuration(saved.meetingDurationMinutes);
        if (saved.bufferBeforeMinutes !== undefined) setBufferBefore(saved.bufferBeforeMinutes);
        if (saved.bufferAfterMinutes !== undefined) setBufferAfter(saved.bufferAfterMinutes);
        if (Array.isArray(saved.availableDays)) setDays(Object.fromEntries(weekDays.map((day) => [day, saved.availableDays.includes(day)])));
        if (saved.startTime) setStartTime(saved.startTime);
        if (saved.endTime) setEndTime(saved.endTime);
        if (saved.timezone) setTimezone(saved.timezone);
        if (typeof saved.suggestAlternatives === "boolean") setSuggestAlternatives(saved.suggestAlternatives);
        if (saved.eventType) setEventType(saved.eventType);
        if (saved.meetingLocation) setMeetingLocation(saved.meetingLocation);
        if (saved.maxBookingsPerDay) setMaxBookings(saved.maxBookingsPerDay);
      }
      if (Array.isArray(integrationPayload?.integrations)) setIntegrations(integrationPayload.integrations);
      setExternalCalendarEnabled(integrationPayload?.entitlements?.externalCalendar === true);
    }).catch(() => undefined);
  }, []);

  const selectedProvider = providers.find((item) => item.id === provider)!;
  const connected = useMemo(() => integrations.some((item) => item.provider === provider && item.status === "CONNECTED"), [integrations, provider]);

  async function save(completeStep: boolean) {
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/setup/calendar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          meetingDurationMinutes: meetingDuration,
          bufferBeforeMinutes: bufferBefore,
          bufferAfterMinutes: bufferAfter,
          availableDays: weekDays.filter((day) => days[day]),
          startTime,
          endTime,
          timezone,
          suggestAlternatives,
          eventType: eventType || null,
          meetingLocation,
          maxBookingsPerDay: maxBookings,
          completeStep,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to save calendar settings.");
      if (completeStep) router.push("/setup/test");
      else setNotice("Calendar settings saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to save calendar settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="calendarSetupPage">
      <header className="siteHeader calendarSetupHeader">
        <Link className="brandMini" href="/welcome" aria-label="AI Caller home"><LogoMark size={35} /><strong>AI Caller</strong></Link>
        <a className="supportLink" href="mailto:support@aicaller.com"><HelpIcon size={17} /><span>Need help?</span><strong>Contact support</strong></a>
      </header>

      <div className="calendarSetupGrid">
        <section className="calendarMainCard">
          <div className="calendarIntro">
            <span className="stepBadge">STEP 4 OF 6</span>
            <h1>{externalCalendarEnabled ? "Connect your calendar" : "Set up appointment booking"}</h1>
            <p>{externalCalendarEnabled ? "AI Caller can check availability and book appointments in-app using your business hours. Connecting an external calendar is optional." : "AI Caller uses your business hours and these booking rules to check availability and create appointments directly in-app."}</p>
            <span className="introHelper">{externalCalendarEnabled ? "Native appointments appear on the Appointments page without Google, Outlook, Calendly or Cal.com. Connect an external provider if you want synced events." : "Core uses the built-in appointment calendar. External calendar connections unlock with Unlimited."}</span>
          </div>

          {externalCalendarEnabled === false ? (
            <section className="calendarAccessBanner">
              <span className="accessIcon"><CalendarIcon size={24} /></span>
              <div><h2>Built-in appointment calendar</h2><p>Core uses AI Caller’s in-app booking and availability. External calendar connections are available on Unlimited.</p><small><LockIcon size={13} /> Upgrade to Unlimited if you want to connect Google Calendar, Outlook, Calendly or Cal.com.</small></div>
            </section>
          ) : externalCalendarEnabled === true ? (
            <>
              <div className="calendarProviderTabs" role="tablist" aria-label="Calendar providers">
                {providers.map((item) => <button key={item.id} type="button" className={provider === item.id ? "active" : ""} onClick={() => setProvider(item.id)}><span className={`providerIcon ${item.tone}`}>{item.badge}</span><span><strong>{item.name}</strong><small>{item.subtitle}</small></span></button>)}
              </div>

              <section className="calendarAccessBanner">
                <span className="accessIcon"><CalendarIcon size={24} /></span>
                <div><h2>{connected ? `${selectedProvider.name} connected` : `Connect ${selectedProvider.name}`}</h2><p>{connected ? "This provider is connected and can be selected as your calendar capability." : "Connect the provider once in Integrations. The same secure integration is then reused here and throughout AI Caller."}</p><small><LockIcon size={13} /> Credentials are stored encrypted and are never returned in plaintext.</small></div>
              </section>

              <section className="calendarConnectSection">
                <h2>{selectedProvider.name}</h2>
                <Link className="calendarConnectButton" href={`/integrations?provider=${provider}&return=%2Fsetup%2Fcalendar`}>
                  <span className={`providerIcon large ${selectedProvider.tone}`}>{selectedProvider.badge}</span>
                  <span><strong>{connected ? `Manage ${selectedProvider.name}` : `Connect ${selectedProvider.name}`}</strong><small>{connected ? "Review or update the shared provider connection" : "Open the secure integration settings"}</small></span>
                  <ChevronRightIcon size={20} />
                </Link>
              </section>
            </>
          ) : null}

          <section className="calendarSettingsSection">
            <div className="calendarSectionTitle"><h2>Calendar settings</h2><p>Configure how your AI assistant should offer and book appointment times.</p></div>

            <div className="calendarSettingsGrid twoCol">
              <label className="calendarField"><span>Default meeting duration</span><select value={meetingDuration} onChange={(event) => setMeetingDuration(Number(event.target.value))}><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={45}>45 minutes</option><option value={60}>60 minutes</option></select></label>
              <label className="calendarField"><span>Buffer before meeting</span><select value={bufferBefore} onChange={(event) => setBufferBefore(Number(event.target.value))}><option value={0}>No buffer</option><option value={10}>10 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option></select></label>
              <label className="calendarField"><span>Buffer after meeting</span><select value={bufferAfter} onChange={(event) => setBufferAfter(Number(event.target.value))}><option value={0}>No buffer</option><option value={10}>10 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option></select></label>
              <label className="calendarField"><span>Event type / booking type</span><input value={eventType} onChange={(event) => setEventType(event.target.value)} placeholder={provider === "calendly" || provider === "calcom" ? "Customer Consultation" : "Appointment"} /></label>
            </div>

            <div className="availabilityBlock"><strong>Available days</strong><div className="daySelector">{weekDays.map((day) => <label key={day} className="dayOption"><input type="checkbox" checked={days[day]} onChange={(event) => setDays((current) => ({ ...current, [day]: event.target.checked }))} /><span className="dayCheck"><CheckIcon size={13} /></span><b>{day}</b></label>)}</div></div>

            <div className="hoursTimezoneGrid">
              <div className="hoursGroup"><strong>Available hours</strong><div className="timeRange"><input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} /><span>to</span><input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></div></div>
              <label className="calendarField timezoneField"><span>Timezone</span><select value={timezone} onChange={(event) => setTimezone(event.target.value)}><option value="Africa/Lagos">(GMT+01:00) Lagos, Nigeria (WAT)</option><option value="America/New_York">New York (ET)</option><option value="Europe/London">London</option></select></label>
            </div>

            <label className="suggestNearestRow"><input type="checkbox" checked={suggestAlternatives} onChange={(event) => setSuggestAlternatives(event.target.checked)} /><span className="squareCheck"><CheckIcon size={14} /></span><span><strong>Allow AI to suggest the nearest available time</strong><small>When the requested time is unavailable, offer the next best slot.</small></span></label>

            <div className={`advancedCalendar ${advancedOpen ? "open" : ""}`}>
              <button type="button" onClick={() => setAdvancedOpen((open) => !open)}><span className="advancedIcon"><GearIcon size={19} /></span><span><strong>Advanced settings</strong><small>Meeting location and daily booking limits.</small></span><ChevronRightIcon size={18} /></button>
              {advancedOpen && <div className="advancedBody"><label className="calendarField"><span>Meeting location</span><select value={meetingLocation} onChange={(event) => setMeetingLocation(event.target.value)}><option>Use provider default</option><option>Google Meet</option><option>Microsoft Teams</option><option>Zoom</option><option>Phone call</option><option>In person</option></select></label><label className="calendarField"><span>Maximum bookings per day</span><input type="number" min={1} max={100} value={maxBookings} onChange={(event) => setMaxBookings(Number(event.target.value))} /></label></div>}
            </div>
          </section>

          {notice && <div className="editableNote calendarEditableNote"><span className="infoBubble"><InfoIcon size={18} /></span><div><strong>{notice}</strong></div></div>}
          <div className="calendarFooter"><Link className="backLink" href="/setup/communication">←&nbsp;&nbsp;Back to Communication</Link><div className="formActions"><button type="button" className="outlineAction" disabled={saving} onClick={() => save(false)}>{saving ? "Saving..." : "Save for later"}</button><button type="button" className="continueAction" disabled={saving} onClick={() => save(true)}>Save &amp; Continue <ChevronRightIcon size={18} /></button></div></div>
        </section>

        <aside className="calendarSidebar">
          <SetupProgressPanel currentStep={4} estimated="5 minutes" className="sidebarCard calendarProgressCard" progressClassName="sidebarProgressBar calendarProgressBar" />
          <section className="sidebarCard calendarWhyCard"><h2>{externalCalendarEnabled ? "Why connect your calendar?" : "Built-in scheduling"}</h2><p>{externalCalendarEnabled ? "Your AI assistant will use one normalized calendar capability regardless of the provider you connect." : "Core books directly into AI Caller using your business hours and appointment settings. No external calendar is required."}</p><div className="calendarBenefits"><div className="calendarBenefit"><span className="benefitIcon green"><CalendarIcon size={16} /></span><div><strong>Real availability</strong><small>Keep booking rules in one place.</small></div></div><div className="calendarBenefit"><span className="benefitIcon blue"><GearIcon size={16} /></span><div><strong>{externalCalendarEnabled ? "Provider-independent" : "Built-in calendar"}</strong><small>{externalCalendarEnabled ? "Google, Outlook, Calendly and Cal.com share the same booking contract." : "Appointments stay inside AI Caller without an external provider."}</small></div></div><div className="calendarBenefit"><span className="benefitIcon green"><ShieldIcon size={16} /></span><div><strong>{externalCalendarEnabled ? "Secure credentials" : "No provider account needed"}</strong><small>{externalCalendarEnabled ? "Connections are stored encrypted." : "Core booking works without external calendar credentials."}</small></div></div></div></section>
        </aside>
      </div>
    </main>
  );
}
