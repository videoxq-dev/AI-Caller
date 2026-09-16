"use client";

import { useState } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  GearIcon,
  InfoIcon,
  LockIcon,
  ShieldIcon,
  SparkleIcon,
  UsersIcon,
} from "@/components/icons";
import "./calendly.css";

export function CalendlyConnectPanel() {
  return (
    <section className="calendlyPanel">
      <div className="calendlyPanelHeading">
        <span className="calendlyMark" aria-hidden="true">C</span>
        <div>
          <h2>Connect your Calendly account</h2>
          <p>Link your Calendly account so your AI assistant can check availability, book meetings and manage appointments.</p>
        </div>
      </div>

      <div className="calendlyFeatureStrip">
        <div><span className="featureBubble blue"><CalendarIcon size={16} /></span><strong>Use your existing</strong><small>Calendly event types</small></div>
        <div><span className="featureBubble purple"><SparkleIcon size={16} /></span><strong>Real-time</strong><small>availability</small></div>
        <div><span className="featureBubble blue"><ChevronRightIcon size={16} /></span><strong>Automatic booking</strong><small>and confirmations</small></div>
        <div><span className="featureBubble purple"><ClockIcon size={16} /></span><strong>Reduce no-shows</strong><small>with reminders</small></div>
      </div>

      <div className="calendlyConnectGrid">
        <button type="button" className="calendlyChoice selected">
          <span className="calendlyRadio" />
          <span className="calendlyChoiceBody">
            <strong>Connect with Calendly</strong>
            <small>Sign in to your Calendly account to give AI Caller access to your event types.</small>
            <span className="calendlyConnectRow">
              <span className="calendlyWordmark"><i>C</i><b>Calendly</b></span>
              <span className="calendlyConnectButton">Connect with Calendly <b>→</b></span>
            </span>
          </span>
        </button>

        <button type="button" className="calendlyChoice">
          <span className="calendlyRadio" />
          <span className="calendlyChoiceBody">
            <strong>Use a different Calendly account</strong>
            <small>Select from your connected Calendly accounts.</small>
            <span className="calendlyAccountSelect">
              <CalendarIcon size={17} />
              <span>Select a Calendly account</span>
              <b>⌄</b>
            </span>
            <em>You can change this anytime in Settings.</em>
          </span>
        </button>
      </div>

      <div className="calendlyPrivacyBar">
        <span className="privacyLock"><LockIcon size={16} /></span>
        <div>
          <strong>Your data is private and secure</strong>
          <small>We only read your availability and event type information. We never create, edit or delete events in your Calendly account.</small>
        </div>
        <a href="#calendly-security">Learn more ↗</a>
      </div>

      <div className="calendlyEventSection">
        <div className="calendlyEventHeading">
          <h3>Calendly event type</h3>
          <p>Choose which event type your AI assistant should use for booking appointments.</p>
        </div>
        <div className="calendlyEventGrid">
          <label className="calendarField">
            <span className="srOnly">Calendly event type</span>
            <select defaultValue="Customer Consultation (30 min)">
              <option>Customer Consultation (30 min)</option>
              <option>Discovery Call (15 min)</option>
              <option>Service Appointment (60 min)</option>
            </select>
          </label>
          <div className="refreshEventTypes">
            <button type="button">↻ &nbsp;Refresh event types</button>
            <small>Don&apos;t see your event type? Refresh the list.</small>
          </div>
        </div>
      </div>
    </section>
  );
}

export function CalendlySettingsPanel() {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <section className="calendarSettingsSection calendlySettingsSection">
      <div className="calendarSectionTitle">
        <h2>Calendar settings</h2>
        <p>Configure how your AI assistant should handle appointments from your Calendly calendar.</p>
      </div>

      <div className="calendarSettingsGrid twoCol">
        <label className="calendarField"><span>Buffer time before meeting</span><select defaultValue="15 minutes"><option>No buffer</option><option>10 minutes</option><option>15 minutes</option><option>30 minutes</option></select></label>
        <label className="calendarField"><span>Buffer time after meeting</span><select defaultValue="15 minutes"><option>No buffer</option><option>10 minutes</option><option>15 minutes</option><option>30 minutes</option></select></label>
      </div>

      <label className="calendlyToggleRow">
        <input type="checkbox" defaultChecked />
        <span className="calendlyToggle"><i /></span>
        <span><strong>Allow AI to suggest alternative times</strong><small>If your preferred time isn&apos;t available, your AI assistant can suggest the next best option.</small></span>
      </label>

      <div className={`advancedCalendar ${advancedOpen ? "open" : ""}`}>
        <button type="button" onClick={() => setAdvancedOpen((open) => !open)}>
          <span className="advancedIcon"><GearIcon size={19} /></span>
          <span><strong>Advanced settings (optional)</strong><small>Set custom scheduling rules, meeting locations, timezone and more.</small></span>
          <ChevronRightIcon size={18} />
        </button>
        {advancedOpen && (
          <div className="advancedBody">
            <label className="calendarField"><span>Meeting location</span><select defaultValue="Use Calendly event default"><option>Use Calendly event default</option><option>Zoom</option><option>Google Meet</option><option>Microsoft Teams</option><option>Phone call</option></select></label>
            <label className="calendarField"><span>Minimum scheduling notice</span><select defaultValue="2 hours"><option>No minimum</option><option>1 hour</option><option>2 hours</option><option>24 hours</option></select></label>
          </div>
        )}
      </div>
    </section>
  );
}

export function CalendlyWhyCard() {
  return (
    <section className="sidebarCard calendarWhyCard calendlyWhyCard">
      <h2>Why connect Calendly?</h2>
      <p>Calendly makes it easy for people to book time with you. By connecting your Calendly account, your AI assistant can check your real-time availability, book appointments and help you manage your schedule — automatically.</p>

      <div className="calendarBenefits calendlyBenefits">
        <div className="calendarBenefit"><span className="benefitIcon green"><CalendarIcon size={16} /></span><div><strong>Book more meetings</strong><small>Let customers schedule with you 24/7</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon purple"><ClockIcon size={16} /></span><div><strong>Reduce no-shows</strong><small>Automatic reminders and follow-ups</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon orange"><UsersIcon size={16} /></span><div><strong>Save time</strong><small>No more back-and-forth emails</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon blue"><SparkleIcon size={16} /></span><div><strong>Works with your existing setup</strong><small>Use your current Calendly event types</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon green"><ShieldIcon size={16} /></span><div><strong>Keep your data secure</strong><small>We only access what&apos;s needed</small></div></div>
      </div>

      <div className="calendlyIllustration" aria-hidden="true">
        <span className="illustrationNote calendlyNote">Turn conversations<br />into booked meetings!</span>
        <div className="calendlyBookingCard">
          <div className="calendlyBookingBrand"><span>C</span><b>Calendly</b></div>
          <strong>Customer Consultation</strong>
          <small>30 minutes</small>
          <div className="calendlyBookingWeek"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span></div>
          <div className="calendlyBookingDates"><i>14</i><i>15</i><i className="selected">16</i><i>17</i><i>18</i></div>
          <div className="calendlyTimeGrid"><span>9:00 AM</span><span>10:00 AM</span><span>11:00 AM</span><span>2:00 PM</span></div>
          <div className="calendlyBookButton">Book with AI Assistant</div>
        </div>
      </div>

      <div className="editableNote calendarEditableNote calendlyEditableNote">
        <span className="infoBubble"><InfoIcon size={18} /></span>
        <div><strong>You can change these settings anytime from Settings.</strong><p>Disconnect, switch calendars, or adjust availability whenever you need to.</p></div>
      </div>
    </section>
  );
}
