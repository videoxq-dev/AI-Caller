import {
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  GearIcon,
  InfoIcon,
  LockIcon,
  ShieldIcon,
  UsersIcon,
} from "@/components/icons";
import "./outlook.css";

export function OutlookConnectPanel() {
  return (
    <section className="outlookPanel">
      <div className="outlookPanelHeading">
        <span className="outlookMark" aria-hidden="true"><b>O</b><i /></span>
        <div>
          <h2>Connect your Microsoft Outlook calendar</h2>
          <p>Securely connect your Outlook or Microsoft 365 calendar so your AI assistant can check availability, book appointments and send reminders.</p>
        </div>
      </div>

      <div className="outlookConnectGrid">
        <button type="button" className="outlookChoice selected">
          <span className="outlookRadio" />
          <span className="outlookChoiceBody">
            <strong>Connect with Microsoft</strong>
            <small>Sign in with your Microsoft account (Outlook or Microsoft 365).</small>
            <span className="microsoftConnectRow">
              <span className="microsoftWordmark"><i className="msRed" /><i className="msGreen" /><i className="msBlue" /><i className="msYellow" /><b>Microsoft</b></span>
              <span className="microsoftConnectButton">Connect with Microsoft <b>→</b></span>
            </span>
          </span>
        </button>

        <button type="button" className="outlookChoice">
          <span className="outlookRadio" />
          <span className="outlookChoiceBody">
            <strong>Use a different calendar</strong>
            <small>Select from your connected Outlook calendars.</small>
            <span className="outlookCalendarSelect">
              <CalendarIcon size={17} />
              <span>Select a calendar</span>
              <b>⌄</b>
            </span>
            <em>You can change this anytime in Settings.</em>
          </span>
        </button>
      </div>

      <div className="outlookPrivacyBar">
        <span className="privacyLock"><LockIcon size={16} /></span>
        <div>
          <strong>Your data is private and secure</strong>
          <small>We only need read and write access to manage appointments. Your calendar data remains private and is never shared.</small>
        </div>
        <a href="#outlook-security">Learn more ↗</a>
      </div>
    </section>
  );
}

export function OutlookWhyCard() {
  return (
    <section className="sidebarCard calendarWhyCard outlookWhyCard">
      <h2>Why connect Outlook?</h2>
      <p>Give your AI assistant access to your Outlook or Microsoft 365 calendar so you can book more appointments, reduce no-shows and save time.</p>

      <div className="calendarBenefits outlookBenefits">
        <div className="calendarBenefit"><span className="benefitIcon green"><CalendarIcon size={16} /></span><div><strong>Check real-time availability</strong><small>Avoid double bookings</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon purple"><ClockIcon size={16} /></span><div><strong>Book appointments automatically</strong><small>Let customers schedule with you 24/7</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon orange"><UsersIcon size={16} /></span><div><strong>Reduce no-shows</strong><small>Send automatic reminders</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon blue"><GearIcon size={16} /></span><div><strong>Works with Microsoft 365</strong><small>Use your existing work or personal account</small></div></div>
        <div className="calendarBenefit"><span className="benefitIcon green"><ShieldIcon size={16} /></span><div><strong>Keep your data secure</strong><small>You stay in control of your calendar</small></div></div>
      </div>

      <div className="outlookIllustration" aria-hidden="true">
        <span className="illustrationNote outlookNote">Turn your Outlook<br />calendar into<br />opportunities!</span>
        <div className="outlookCalendarArt">
          <div className="outlookArtHeader"><span className="outlookMiniMark">O</span><b>Outlook</b></div>
          <div className="outlookArtWeek"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span></div>
          <div className="outlookArtGrid">{Array.from({ length: 15 }).map((_, index) => <i key={index} />)}</div>
          <div className="outlookAppointment"><strong>Customer Consultation</strong><span>Mon, Apr 21 • 10:00 AM</span><small><CheckIcon size={11} /> Booked by AI Assistant</small></div>
        </div>
      </div>

      <div className="editableNote calendarEditableNote outlookEditableNote">
        <span className="infoBubble"><InfoIcon size={18} /></span>
        <div><strong>You can change these settings anytime from Settings.</strong><p>Disconnect, switch calendars, or adjust availability whenever you need to.</p></div>
      </div>
    </section>
  );
}
