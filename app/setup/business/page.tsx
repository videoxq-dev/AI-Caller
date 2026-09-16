import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  FlaskIcon,
  HelpIcon,
  InfoIcon,
  LockIcon,
  LogoMark,
  MapPinIcon,
  PhoneIcon,
  RocketIcon,
  SparkleIcon,
  StoreIcon,
  UsersIcon,
} from "@/components/icons";
import "./business-profile.css";

type ProgressStep = {
  number: number;
  title: string;
  description: string;
  tone: "blue" | "purple" | "green" | "orange";
  icon: ReactNode;
};

const progressSteps: ProgressStep[] = [
  { number: 1, title: "Add your business", description: "Business details, hours and service area", tone: "blue", icon: <StoreIcon size={21} /> },
  { number: 2, title: "Teach your AI", description: "Services, FAQs and policies", tone: "purple", icon: <SparkleIcon size={21} /> },
  { number: 3, title: "Connect communication", description: "Phone, SMS, WhatsApp and web chat", tone: "green", icon: <PhoneIcon size={20} /> },
  { number: 4, title: "Connect your calendar", description: "Google, Outlook, Calendly or Cal.com", tone: "orange", icon: <CalendarIcon size={20} /> },
  { number: 5, title: "Test your AI", description: "Run a chat or call test before going live", tone: "purple", icon: <FlaskIcon size={20} /> },
  { number: 6, title: "Go live", description: "Activate your assistant and start handling inquiries", tone: "blue", icon: <RocketIcon size={20} /> },
];

const days = [
  { day: "Monday", open: "8:00 AM", close: "6:00 PM", enabled: true },
  { day: "Tuesday", open: "8:00 AM", close: "6:00 PM", enabled: true },
  { day: "Wednesday", open: "8:00 AM", close: "6:00 PM", enabled: true },
  { day: "Thursday", open: "8:00 AM", close: "6:00 PM", enabled: true },
  { day: "Friday", open: "8:00 AM", close: "6:00 PM", enabled: true },
  { day: "Saturday", open: "9:00 AM", close: "3:00 PM", enabled: true },
  { day: "Sunday", open: "", close: "", enabled: false },
];

export default function BusinessProfilePage() {
  return (
    <main className="businessSetupPage">
      <header className="siteHeader businessSetupHeader">
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

      <div className="businessSetupGrid">
        <section className="businessFormCard">
          <div className="businessIntro">
            <span className="stepBadge">STEP 1 OF 6</span>
            <h1>Add your business</h1>
            <p>Tell us about your business so your AI assistant can answer customers accurately.</p>
          </div>

          <form className="businessProfileForm">
            <section className="formSection">
              <div className="sectionHeading">
                <span className="sectionIcon blue"><StoreIcon size={22} /></span>
                <div><h2>Business details</h2><p>Basic information about your business.</p></div>
              </div>

              <div className="fieldGrid twoColumns">
                <label className="businessField">
                  <span>Business name</span>
                  <input type="text" name="businessName" defaultValue="Brightside Auto Spa" />
                </label>
                <label className="businessField">
                  <span>Industry</span>
                  <select name="industry" defaultValue="Auto Repair">
                    <option>Auto Repair</option><option>Plumbing</option><option>HVAC</option><option>Roofing</option><option>Dental</option><option>Med Spa</option><option>Cleaning</option><option>Other</option>
                  </select>
                </label>
                <label className="businessField">
                  <span>Website URL</span>
                  <input type="url" name="website" defaultValue="https://www.brightsideautospa.com" />
                </label>
                <label className="businessField">
                  <span>Business phone</span>
                  <input type="tel" name="phone" defaultValue="(305) 555-0142" />
                  <small>We&apos;ll use this number for your AI assistant to handle calls.</small>
                </label>
              </div>
            </section>

            <section className="formSection">
              <div className="sectionHeading">
                <span className="sectionIcon blue"><MapPinIcon size={22} /></span>
                <div><h2>Location &amp; service area</h2><p>Let us know where you&apos;re located and the area you serve.</p></div>
              </div>

              <div className="fieldGrid locationGrid">
                <label className="businessField addressField">
                  <span>Address</span>
                  <input type="text" name="address" defaultValue="1452 Palm Ave, Miami, FL 33101" />
                </label>
                <label className="businessField"><span>City</span><input type="text" name="city" defaultValue="Miami" /></label>
                <label className="businessField"><span>State</span><select name="state" defaultValue="Florida"><option>Florida</option><option>California</option><option>New York</option><option>Texas</option></select></label>
                <label className="businessField"><span>ZIP code</span><input type="text" inputMode="numeric" name="zip" defaultValue="33101" /></label>
                <label className="businessField radiusField"><span>Service area / radius</span><select name="radius" defaultValue="Within 20 miles"><option>Within 10 miles</option><option>Within 20 miles</option><option>Within 30 miles</option><option>Within 50 miles</option><option>Custom area</option></select></label>
                <p className="fieldHelper">Your AI will be able to answer questions from customers in this area.</p>
              </div>
            </section>

            <section className="formSection hoursSection">
              <div className="hoursHeader">
                <div className="sectionHeading compact">
                  <span className="sectionIcon purple"><ClockIcon size={22} /></span>
                  <div><h2>Hours of operation</h2><p>Set the days and times your business is open.</p></div>
                </div>
                <label className="timezoneField"><span>Timezone</span><select defaultValue="Eastern Time (ET)"><option>Eastern Time (ET)</option><option>Central Time (CT)</option><option>Mountain Time (MT)</option><option>Pacific Time (PT)</option></select></label>
              </div>

              <div className="hoursTable">
                {days.map((row) => (
                  <div className={`hoursRow ${!row.enabled ? "closed" : ""}`} key={row.day}>
                    <strong>{row.day}</strong>
                    <label className="toggle" aria-label={`${row.day} open`}>
                      <input type="checkbox" defaultChecked={row.enabled} />
                      <span />
                    </label>
                    {row.enabled ? (
                      <>
                        <select aria-label={`${row.day} opening time`} defaultValue={row.open}><option>8:00 AM</option><option>9:00 AM</option><option>10:00 AM</option></select>
                        <span className="toLabel">to</span>
                        <select aria-label={`${row.day} closing time`} defaultValue={row.close}><option>3:00 PM</option><option>5:00 PM</option><option>6:00 PM</option><option>7:00 PM</option></select>
                      </>
                    ) : (
                      <div className="closedField">Closed</div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <div className="formFooter">
              <Link className="backLink" href="/welcome">←&nbsp;&nbsp;Back to welcome</Link>
              <div className="formActions">
                <button type="button" className="outlineAction">Save for later</button>
                <button type="button" className="continueAction">Save &amp; Continue <ArrowRightIcon size={18} /></button>
              </div>
            </div>
          </form>
        </section>

        <aside className="businessSidebar">
          <section className="sidebarCard progressSidebarCard">
            <div className="sidebarProgressTop"><h2>Setup progress</h2><span>Estimated setup time: 7 minutes</span></div>
            <div className="sidebarProgressBar"><span /></div>
            <div className="sidebarProgressMeta"><span>1 of 6 completed</span><strong>17%</strong></div>

            <div className="sidebarSteps">
              {progressSteps.map((step) => (
                <div className={`sidebarStep ${step.number === 1 ? "active" : "locked"}`} key={step.number}>
                  <span className="sidebarStepNumber">{step.number}</span>
                  <span className={`sidebarStepIcon ${step.tone}`}>{step.icon}</span>
                  <div><strong>{step.title}</strong><span>{step.description}</span></div>
                  {step.number === 1 ? <ChevronRightIcon size={18} /> : <LockIcon size={15} />}
                </div>
              ))}
            </div>
          </section>

          <section className="sidebarCard whyCard">
            <h2>Why this matters</h2>
            <p>Your business details, service area and hours help your AI assistant answer customer questions correctly, provide accurate information, and avoid booking errors.</p>

            <div className="whyBody">
              <div className="benefitList">
                <div className="benefitItem"><span className="benefitIcon green"><CheckIcon size={16} /></span><span>Gives accurate answers about your business</span></div>
                <div className="benefitItem"><span className="benefitIcon purple"><UsersIcon size={16} /></span><span>Helps customers know if you&apos;re available</span></div>
                <div className="benefitItem"><span className="benefitIcon blue"><CalendarIcon size={16} /></span><span>Prevents scheduling conflicts</span></div>
              </div>

              <div className="storeIllustration" aria-hidden="true">
                <span className="illustrationNote">Accurate info.<br />Happier customers.</span>
                <span className="mapPinBubble"><MapPinIcon size={22} /></span>
                <div className="storeRoof" /><div className="storeAwning" /><div className="storeBody"><i /><i /></div>
              </div>
            </div>

            <div className="editableNote">
              <span className="infoBubble"><InfoIcon size={18} /></span>
              <div><strong>You can edit these details anytime from Settings.</strong><p>As your business grows, you can update your information, hours or service area at any time.</p></div>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
