"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  GearIcon,
  HelpIcon,
  InfoIcon,
  LockIcon,
  LogoMark,
  RocketIcon,
  ShieldIcon,
  SparkleIcon,
  StoreIcon,
  UsersIcon,
} from "@/components/icons";
import { OutlookConnectPanel, OutlookWhyCard } from "./outlook-tab";
import { CalendlyConnectPanel, CalendlySettingsPanel, CalendlyWhyCard } from "./calendly-tab";
import "./shared.css";
import "./calendar.css";

type CalendarProvider = "google" | "outlook" | "calendly" | "calcom";
type ProgressState = "complete" | "active" | "locked";
type ProgressStep = {
  number: number;
  title: string;
  description: string;
  tone: "blue" | "purple" | "green" | "orange";
  icon: ReactNode;
  state: ProgressState;
};

const progressSteps: ProgressStep[] = [
  { number: 1, title: "Add your business", description: "Business details, hours and service area", tone: "blue", icon: <StoreIcon size={20} />, state: "complete" },
  { number: 2, title: "Teach your AI", description: "Services, FAQs and policies", tone: "purple", icon: <SparkleIcon size={20} />, state: "complete" },
  { number: 3, title: "Connect communication", description: "Phone, SMS, WhatsApp and web chat", tone: "green", icon: <UsersIcon size={20} />, state: "complete" },
  { number: 4, title: "Connect your calendar", description: "Google, Outlook, Calendly or Cal.com", tone: "orange", icon: <CalendarIcon size={20} />, state: "active" },
  { number: 5, title: "Test your AI", description: "Run a chat or call test before going live", tone: "purple", icon: <SparkleIcon size={20} />, state: "locked" },
  { number: 6, title: "Go live", description: "Activate your assistant and start handling inquiries", tone: "blue", icon: <RocketIcon size={20} />, state: "locked" },
];

const providers: Array<{ id: CalendarProvider; name: string; subtitle: string; badge: string; tone: string }> = [
  { id: "google", name: "Google Calendar", subtitle: "Most popular", badge: "G", tone: "google" },
  { id: "outlook", name: "Microsoft Outlook", subtitle: "For Microsoft 365", badge: "O", tone: "outlook" },
  { id: "calendly", name: "Calendly", subtitle: "Simple and powerful", badge: "C", tone: "calendly" },
  { id: "calcom", name: "Cal.com", subtitle: "For advanced users", badge: "Cal", tone: "calcom" },
];

const weekDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function CalendarSetupPage() {
  const [provider, setProvider] = useState<CalendarProvider>("google");
  const [days, setDays] = useState<Record<string, boolean>>({ Mon: true, Tue: true, Wed: true, Thu: true, Fri: true, Sat: false, Sun: false });
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const selectedProvider = providers.find((item) => item.id === provider)!;

  return (
    <main className="calendarSetupPage">
      <header className="siteHeader calendarSetupHeader">
        <Link className="brandMini" href="/welcome" aria-label="AI Caller home">
          <LogoMark size={35} />
          <strong>AI Caller</strong>
        </Link>
        <a className="supportLink" href="mailto:support@aicaller.com">
          <HelpIcon size={17} />
          <span>Need help?</span>
          <strong>Contact support</strong>
        </a>
      </header>

      <div className="calendarSetupGrid">
        <section className="calendarMainCard">
          <div className="calendarIntro">
            <span className="stepBadge">STEP 4 OF 6</span>
            <h1>Connect your calendar</h1>
            <p>Link your calendar so your AI assistant can check availability, book appointments and send reminders.</p>
            <span className="introHelper">You can connect Google Calendar, Outlook, Calendly or Cal.com. Use your existing calendar or create a new one.</span>
          </div>

          <div className="calendarProviderTabs" role="tablist" aria-label="Calendar providers">
            {providers.map((item) => (
              <button key={item.id} type="button" className={provider === item.id ? "active" : ""} onClick={() => setProvider(item.id)}>
                <span className={`providerIcon ${item.tone}`}>{item.badge}</span>
                <span><strong>{item.name}</strong><small>{item.subtitle}</small></span>
              </button>
            ))}
          </div>

          {provider === "outlook" ? (
            <OutlookConnectPanel />
          ) : provider === "calendly" ? (
            <CalendlyConnectPanel />
          ) : (
            <>
              <section className="calendarAccessBanner">
                <span className="accessIcon"><CalendarIcon size={24} /></span>
                <div>
                  <h2>Give your AI assistant access to your calendar</h2>
                  <p>We only need read and write access to manage appointments. Your calendar data remains private and secure.</p>
                  <small><LockIcon size={13} /> Your data is encrypted and never shared.</small>
                </div>
              </section>

              <section className="calendarConnectSection">
                <h2>Connect your {selectedProvider.name}</h2>
                <button type="button" className="calendarConnectButton">
                  <span className={`providerIcon large ${selectedProvider.tone}`}>{selectedProvider.badge}</span>
                  <span><strong>Connect with {provider === "google" ? "Google" : selectedProvider.name}</strong><small>Securely connect your {selectedProvider.name} account</small></span>
                  <ChevronRightIcon size={20} />
                </button>
                <div className="calendarOr"><span />or<span /></div>
                <button type="button" className="calendarSecondaryButton">
                  <span className="secondaryIcon"><CalendarIcon size={21} /></span>
                  <span><strong>Use a different calendar</strong><small>Select from your connected {selectedProvider.name} accounts</small></span>
                  <ChevronRightIcon size={20} />
                </button>
              </section>
            </>
          )}

          {provider === "calendly" ? (
            <CalendlySettingsPanel />
          ) : (
            <section className="calendarSettingsSection">
              <div className="calendarSectionTitle">
                <h2>Calendar settings</h2>
                <p>{provider === "outlook" ? "Configure how your AI assistant should handle appointments from your Outlook calendar." : "Configure how your AI assistant should handle appointments."}</p>
              </div>

              <div className="calendarSettingsGrid twoCol">
                <label className="calendarField"><span>Default meeting duration</span><select defaultValue="30 minutes"><option>15 minutes</option><option>30 minutes</option><option>45 minutes</option><option>60 minutes</option></select></label>
                <label className="calendarField"><span>Buffer time between meetings</span><select defaultValue="15 minutes"><option>No buffer</option><option>10 minutes</option><option>15 minutes</option><option>30 minutes</option></select></label>
              </div>

              <div className="availabilityBlock">
                <strong>Available days</strong>
                <div className="daySelector">
                  {weekDays.map((day) => (
                    <label key={day} className="dayOption">
                      <input type="checkbox" checked={days[day]} onChange={(event) => setDays((current) => ({ ...current, [day]: event.target.checked }))} />
                      <span className="dayCheck"><CheckIcon size={13} /></span>
                      <b>{day}</b>
                    </label>
                  ))}
                </div>
              </div>

              <div className="hoursTimezoneGrid">
                <div className="hoursGroup">
                  <strong>Available hours</strong>
                  <div className="timeRange">
                    <select defaultValue="9:00 AM"><option>8:00 AM</option><option>9:00 AM</option><option>10:00 AM</option></select>
                    <span>to</span>
                    <select defaultValue="5:00 PM"><option>4:00 PM</option><option>5:00 PM</option><option>6:00 PM</option></select>
                  </div>
                </div>
                <label className="calendarField timezoneField"><span>Timezone</span><select defaultValue="Lagos"><option value="Lagos">(GMT+01:00) Lagos, Nigeria (WAT)</option><option value="New York">(GMT-05:00) New York (ET)</option><option value="London">(GMT+00:00) London (GMT)</option></select></label>
              </div>

              <label className="suggestNearestRow">
                <input type="checkbox" defaultChecked />
                <span className="squareCheck"><CheckIcon size={14} /></span>
                <span><strong>Allow AI to suggest the nearest available time</strong><small>When your preferred time isn&apos;t available, your AI assistant can suggest the next best option.</small></span>
              </label>

              <div className={`advancedCalendar ${advancedOpen ? "open" : ""}`}>
                <button type="button" onClick={() => setAdvancedOpen((open) => !open)}>
                  <span className="advancedIcon"><GearIcon size={19} /></span>
                  <span><strong>Advanced settings (optional)</strong><small>{provider === "outlook" ? "Set specific event types, locations, meeting links, availability rules and more." : "Set specific event types, locations, meeting links and more"}</small></span>
                  <ChevronRightIcon size={18} />
                </button>
                {advancedOpen && (
                  <div className="advancedBody">
                    <label className="calendarField"><span>Meeting location</span><select defaultValue="Use calendar default"><option>Use calendar default</option><option>Microsoft Teams</option><option>Google Meet</option><option>Zoom</option><option>Phone call</option></select></label>
                    <label className="calendarField"><span>Maximum bookings per day</span><input type="number" min={1} defaultValue={8} /></label>
                  </div>
                )}
              </div>
            </section>
          )}

          <div className="calendarFooter">
            <Link className="backLink" href="/setup/communication">←&nbsp;&nbsp;Back to Communication</Link>
            <div className="formActions">
              <button type="button" className="outlineAction">Save for later</button>
              <Link className="continueAction" href="/setup/test">Save &amp; Continue <ChevronRightIcon size={18} /></Link>
            </div>
          </div>
        </section>

        <aside className="calendarSidebar">
          <section className="sidebarCard calendarProgressCard">
            <div className="sidebarProgressTop"><h2>Setup progress</h2><span>Estimated setup time: 5 minutes</span></div>
            <div className="sidebarProgressBar calendarProgressBar"><span /></div>
            <div className="sidebarProgressMeta"><span>3 of 6 completed</span><strong>67%</strong></div>

            <div className="sidebarSteps calendarSteps">
              {progressSteps.map((step) => (
                <div className={`sidebarStep ${step.state}`} key={step.number}>
                  <span className="sidebarStepNumber">{step.number}</span>
                  <span className={`sidebarStepIcon ${step.tone}`}>{step.state === "complete" ? <CheckIcon size={20} /> : step.icon}</span>
                  <div><strong>{step.title}</strong><span>{step.description}</span></div>
                  {step.state === "locked" ? <LockIcon size={15} /> : step.state === "active" ? <ChevronRightIcon size={18} /> : null}
                </div>
              ))}
            </div>
          </section>

          {provider === "outlook" ? (
            <OutlookWhyCard />
          ) : provider === "calendly" ? (
            <CalendlyWhyCard />
          ) : (
            <section className="sidebarCard calendarWhyCard">
              <h2>Why connect your calendar?</h2>
              <p>Your AI assistant will check your real-time availability, book appointments, send confirmations and reminders, and help you manage your schedule — automatically.</p>

              <div className="calendarBenefits">
                <div className="calendarBenefit"><span className="benefitIcon green"><CalendarIcon size={16} /></span><div><strong>Book more appointments</strong><small>Let customers schedule with you 24/7</small></div></div>
                <div className="calendarBenefit"><span className="benefitIcon purple"><ClockIcon size={16} /></span><div><strong>Reduce no-shows</strong><small>Automatic reminders and follow-ups</small></div></div>
                <div className="calendarBenefit"><span className="benefitIcon orange"><UsersIcon size={16} /></span><div><strong>Sync in real time</strong><small>Always up-to-date availability</small></div></div>
                <div className="calendarBenefit"><span className="benefitIcon blue"><GearIcon size={16} /></span><div><strong>Work with your existing tools</strong><small>Use the calendar you already rely on</small></div></div>
                <div className="calendarBenefit"><span className="benefitIcon green"><ShieldIcon size={16} /></span><div><strong>Keep your data secure</strong><small>We only access what&apos;s needed</small></div></div>
              </div>

              <div className="calendarIllustration" aria-hidden="true">
                <span className="illustrationNote calendarNote">Turn conversations<br />into appointments!</span>
                <div className="miniCalendar">
                  <div className="miniCalendarHeader"><strong>April 2025</strong><span>○</span></div>
                  <div className="miniWeek"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span></div>
                  <div className="miniDots">{Array.from({ length: 15 }).map((_, index) => <i key={index} />)}</div>
                  <div className="miniAppointment"><b>10:00 AM</b><span>Customer Consultation</span></div>
                  <span className="miniSuccess"><CheckIcon size={17} /></span>
                  <div className="miniConfirm">Your appointment is confirmed!</div>
                </div>
              </div>

              <div className="editableNote calendarEditableNote">
                <span className="infoBubble"><InfoIcon size={18} /></span>
                <div><strong>You can change these settings anytime from Settings.</strong><p>Reconnect, add another calendar, or adjust availability whenever you need to.</p></div>
              </div>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
