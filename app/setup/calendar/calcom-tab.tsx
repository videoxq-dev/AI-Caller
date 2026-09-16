"use client";

import { useState } from "react";
import {
  CalendarIcon,
  ChevronRightIcon,
  ClockIcon,
  GearIcon,
  InfoIcon,
  LockIcon,
  ShieldIcon,
  SparkleIcon,
  UsersIcon,
} from "@/components/icons";
import "./calcom.css";

export function CalcomConnectPanel() {
  return (
    <section className="calcomPanel">
      <div className="calcomPanelHeading">
        <span className="calcomMark" aria-hidden="true">Cal</span>
        <div>
          <h2>Connect your Cal.com account</h2>
          <p>Link your Cal.com account so your AI assistant can check availability, book meetings and manage appointments.</p>
        </div>
      </div>

      <div className="calcomFeatureStrip">
        <div><span className="calcomFeatureBubble blue"><CalendarIcon size={16} /></span><strong>Use your existing</strong><small>event types</small></div>
        <div><span className="calcomFeatureBubble purple"><SparkleIcon size={16} /></span><strong>Real-time</strong><small>availability</small></div>
        <div><span className="calcomFeatureBubble blue"><ChevronRightIcon size={16} /></span><strong>Automatic booking</strong><small>and confirmations</small></div>
        <div><span className="calcomFeatureBubble blue"><GearIcon size={16} /></span><strong>Flexible, open source</strong><small>and customizable</small></div>
      </div>

      <div className="calcomConnectGrid">
        <button type="button" className="calcomChoice selected">
          <span className="calcomRadio" />
          <span className="calcomChoiceBody">
            <strong>Connect with Cal.com</strong>
            <small>Sign in to your Cal.com account to give AI Caller access to your event types.</small>
            <span className="calcomConnectRow">
              <span className="calcomWordmark"><i>Cal</i><b>Cal.com</b></span>
              <span className="calcomConnectButton">Connect with Cal.com <b>→</b></span>
            </span>
          </span>
        </button>

        <button type="button" className="calcomChoice">
          <span className="calcomRadio" />
          <span className="calcomChoiceBody">
            <strong>Use a different Cal.com account</strong>
            <small>Select from your connected Cal.com accounts.</small>
            <span className="calcomAccountSelect">
              <CalendarIcon size={17} />
              <span>Select a Cal.com account</span>
              <b>⌄</b>
            </span>
            <em>You can change this anytime in Settings.</em>
          </span>
        </button>
      </div>

      <div className="calcomPrivacyBar">
        <span className="privacyLock"><LockIcon size={16} /></span>
        <div>
          <strong>Your data is private and secure</strong>
          <small>We only read your availability and event type information. We never create, edit or delete events in your Cal.com account.</small>
        </div>
        <a href="#calcom-security">Learn more ↗</a>
      </div>

      <div className="calcomEventSection">
        <div className="calcomEventHeading">
          <h3>Cal.com event type</h3>
          <p>Choose which event type your AI assistant should use for booking appointments.</p>
        </div>
        <div className="calcomEventGrid">
          <label className="calendarField">
            <span className="srOnly">Cal.com event type</span>
            <select defaultValue="Customer Consultation (30 min)">
              <option>Customer Consultation (30 min)</option>
              <option>Quick Discovery Call (15 min)</option>
              <option>Service Appointment (60 min)</option>
              <option>Team Consultation (45 min)</option>
            </select>
          </label>
          <div className="calcomRefreshEventTypes">
            <button type="button">↻ &nbsp;Refresh event types</button>
            <small>Don&apos;t see your event type? Refresh the list.</small>
          </div>
        </div>
      </div>
    </section>
  );
}

export function CalcomSettingsPanel() {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <section className="calendarSettingsSection calcomSettingsSection">
      <div className="calendarSectionTitle">
        <h2>Calendar settings</h2>
        <p>Configure how your AI assistant should handle appointments from your Cal.com calendar.</p>
      </div>

      <div className="calendarSettingsGrid twoCol">
        <label className="calendarField"><span>Buffer time before meeting</span><select defaultValue="15 minutes"><option>No buffer</option><option>10 minutes</option><option>15 minutes</option><option>30 minutes</option></select></label>
        <label className="calendarField"><span>Buffer time after meeting</span><select defaultValue="15 minutes"><option>No buffer</option><option>10 minutes</option><option>15 minutes</option><option>30 minutes</option></select></label>
      </div>

      <label className="calcomToggleRow">
        <input type="checkbox" defaultChecked />
        <span className="calcomToggle"><i /></span>
        <span><strong>Allow AI to suggest alternative times</strong><small>If your preferred time isn&apos;t available, your AI assistant can suggest the next best option.</small></span>
      </label>

      <div className={`advancedCalendar ${advancedOpen ? "open" : ""}`}>
        <button type="button" onClick={() => setAdvancedOpen((open) => !open)}>
          <span className="advancedIcon"><GearIcon size={19} /></span>
          <span><strong>Advanced settings (optional)</strong><small>Set custom scheduling rules, meeting locations, timezone, team routing and more.</small></span>
          <ChevronRightIcon size={18} />
        </button>
        {advancedOpen && (
          <div className="advancedBody calcomAdvancedBody">
            <label className="calendarField"><span>Meeting location</span><select defaultValue="Use Cal.com event default"><option>Use Cal.com event default</option><option>Cal Video</option><option>Zoom</option><option>Google Meet</option><option>Microsoft Teams</option><option>Phone call</option></select></label>
            <label className="calendarField"><span>Minimum scheduling notice</span><select defaultValue="2 hours"><option>No minimum</option><option>1 hour</option><option>2 hours</option><option>24 hours</option></select></label>
            <label className="calendarField"><span>Team routing</span><select defaultValue="Use event type default"><option>Use event type default</option><option>Round robin</option><option>Collective availability</option><option>Fixed host</option></select></label>
            <label className="calendarField"><span>Maximum bookings per day</span><input type="number" min={1} defaultValue={8} /></label>
          </div>
        )}
      </div>
    </section>
  );
}

export function CalcomWhyCard() {
  return (
    <section className="sidebarCard calendarWhyCard calcomWhyCard">
      <h2>Why connect Cal.com?</h2>
      <p>Cal.com is a flexible, modern scheduling platform for individuals and teams. Connect it so your AI assistant can handle bookings, check availability and help you stay organized automatically.</p>

      <div className="calendarBenefits calcomBenefits">
        <div className="calendarBenefit"><span className="benefitIcon green"><CalendarIcon size={16} /></span><div><strong>Book more meetings</strong><small>Let customers schedule with you 24/7</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon purple"><ClockIcon size={16} /></span><div><strong>Reduce no-shows</strong><small>Automatic reminders and follow-ups</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon orange"><UsersIcon size={16} /></span><div><strong>Works with your existing setup</strong><small>Use your current Cal.com event types</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon blue"><GearIcon size={16} /></span><div><strong>Flexible and customizable</strong><small>Supports teams, round-robin and custom availability</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon green"><ShieldIcon size={16} /></span><div><strong>Keep your data secure</strong><small>We only access what&apos;s needed</small></div></div>
      </div>

      <div className="calcomIllustration" aria-hidden="true">
        <span className="illustrationNote calcomNote">Turn conversations<br />into scheduled<br />meetings!</span>
        <div className="calcomBookingCard">
          <div className="calcomBookingBrand"><span>Cal</span><b>Cal.com</b></div>
          <strong>Customer Consultation</strong>
          <small>30 minutes</small>
          <div className="calcomBookingWeek"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span></div>
          <div className="calcomBookingDates"><i>14</i><i>15</i><i className="selected">16</i><i>17</i><i>18</i></div>
          <div className="calcomTimeGrid"><span>9:00 AM</span><span>10:00 AM</span><span>11:00 AM</span><span>2:00 PM</span></div>
          <div className="calcomBookButton">Book with AI Assistant</div>
        </div>
      </div>

      <div className="editableNote calendarEditableNote calcomEditableNote">
        <span className="infoBubble"><InfoIcon size={18} /></span>
        <div><strong>You can change these settings anytime from Settings.</strong><p>Disconnect, switch calendars, or adjust availability whenever you need to.</p></div>
      </div>
    </section>
  );
}
