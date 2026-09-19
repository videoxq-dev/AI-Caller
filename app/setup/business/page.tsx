import Link from "next/link";
import { headers } from "next/headers";
import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  HelpIcon,
  InfoIcon,
  LogoMark,
  MapPinIcon,
  StoreIcon,
  UsersIcon,
} from "@/components/icons";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getBusinessSetup, getSetupStatus } from "@/server/domain/onboarding/repository";
import { saveBusinessSetupAction } from "../actions";
import { SetupProgressPanel } from "../setup-progress";
import { IndustryField } from "./industry-field";
import "./business-profile.css";

const defaultDays = [
  { dayOfWeek: 1, day: "Monday", open: "08:00", close: "18:00", enabled: true },
  { dayOfWeek: 2, day: "Tuesday", open: "08:00", close: "18:00", enabled: true },
  { dayOfWeek: 3, day: "Wednesday", open: "08:00", close: "18:00", enabled: true },
  { dayOfWeek: 4, day: "Thursday", open: "08:00", close: "18:00", enabled: true },
  { dayOfWeek: 5, day: "Friday", open: "08:00", close: "18:00", enabled: true },
  { dayOfWeek: 6, day: "Saturday", open: "09:00", close: "15:00", enabled: true },
  { dayOfWeek: 0, day: "Sunday", open: "", close: "", enabled: false },
];

const timeOptions = Array.from({ length: 24 }, (_, hour) => {
  const value = `${String(hour).padStart(2, "0")}:00`;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return { value, label: `${displayHour}:00 ${suffix}` };
});

const timezones = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];

function normalizeStoredTime(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  if (/^(?:[01]\d|2[0-3]):00$/.test(value)) return value;
  const match = /^(\d{1,2}):00\s*(AM|PM)$/i.exec(value.trim());
  if (!match) return fallback;
  let hour = Number(match[1]) % 12;
  if (match[2].toUpperCase() === "PM") hour += 12;
  return `${String(hour).padStart(2, "0")}:00`;
}

export default async function BusinessProfilePage() {
  const context = await resolveWorkspaceContext(await headers());
  const [saved, setup] = await Promise.all([
    getBusinessSetup(context.workspace.id),
    getSetupStatus(context.workspace.id),
  ]);
  const hourMap = new Map(saved.hours.map((row) => [row.dayOfWeek, row]));
  const days = defaultDays.map((day) => {
    const stored = hourMap.get(day.dayOfWeek);
    return stored
      ? { ...day, open: normalizeStoredTime(stored.openTime, day.open), close: normalizeStoredTime(stored.closeTime, day.close), enabled: stored.enabled }
      : day;
  });
  const profile = saved.profile;

  return (
    <main className="businessSetupPage">
      <header className="siteHeader businessSetupHeader">
        <Link className="brandMini" href="/welcome" aria-label="AI Caller home"><LogoMark size={35} /><strong>AI Caller</strong></Link>
        <a className="supportLink" href="mailto:support@aicaller.com"><HelpIcon size={17} /><span>Need help?</span><strong>Contact support</strong></a>
      </header>

      <div className="businessSetupGrid">
        <section className="businessFormCard">
          <div className="businessIntro">
            <span className="stepBadge">STEP 1 OF 6</span>
            <h1>Add your business</h1>
            <p>Tell us about your business so your AI assistant can answer customers accurately.</p>
          </div>

          <form className="businessProfileForm" action={saveBusinessSetupAction}>
            <section className="formSection">
              <div className="sectionHeading"><span className="sectionIcon blue"><StoreIcon size={22} /></span><div><h2>Business details</h2><p>Basic information about your business.</p></div></div>
              <div className="fieldGrid twoColumns">
                <label className="businessField"><span>Business name</span><input type="text" name="businessName" defaultValue={profile?.businessName ?? ""} required /></label>
                <IndustryField initialIndustry={profile?.industry} />
                <label className="businessField"><span>Website URL</span><input type="url" name="website" defaultValue={profile?.websiteUrl ?? ""} /></label>
                <label className="businessField"><span>Business phone</span><input type="tel" name="phone" defaultValue={profile?.phone ?? ""} /><small>We&apos;ll use this number for your AI assistant to handle calls.</small></label>
              </div>
            </section>

            <section className="formSection">
              <div className="sectionHeading"><span className="sectionIcon blue"><MapPinIcon size={22} /></span><div><h2>Location &amp; service area</h2><p>Let us know where you&apos;re located and the area you serve.</p></div></div>
              <div className="fieldGrid locationGrid">
                <label className="businessField addressField"><span>Address</span><input type="text" name="address" defaultValue={profile?.address ?? ""} /></label>
                <label className="businessField"><span>City</span><input type="text" name="city" defaultValue={profile?.city ?? ""} /></label>
                <label className="businessField"><span>State</span><input type="text" name="state" defaultValue={profile?.state ?? ""} /></label>
                <label className="businessField"><span>ZIP / postal code</span><input type="text" name="zip" defaultValue={profile?.postalCode ?? ""} /></label>
                <label className="businessField radiusField"><span>Service area / radius</span><select name="radius" defaultValue={profile?.serviceRadius ?? "Within 20 miles"}><option>Within 10 miles</option><option>Within 20 miles</option><option>Within 30 miles</option><option>Within 50 miles</option><option>Custom area</option></select></label>
                <label className="businessField"><span>Country</span><input type="text" name="country" defaultValue={profile?.country ?? ""} /></label>
              </div>
            </section>

            <section className="formSection hoursSection">
              <div className="hoursHeader">
                <div className="sectionHeading compact"><span className="sectionIcon purple"><ClockIcon size={22} /></span><div><h2>Hours of operation</h2><p>Set the days and times your business is open.</p></div></div>
                <label className="timezoneField"><span>Timezone</span><select name="timezone" defaultValue={profile?.timezone ?? "UTC"}>{timezones.map((timezone) => <option value={timezone} key={timezone}>{timezone}</option>)}</select></label>
              </div>
              <div className="hoursTable">
                {days.map((row) => (
                  <div className={`hoursRow ${!row.enabled ? "closed" : ""}`} key={row.dayOfWeek}>
                    <strong>{row.day}</strong>
                    <label className="toggle" aria-label={`${row.day} open`}><input name={`hours.${row.dayOfWeek}.enabled`} type="checkbox" defaultChecked={row.enabled} /><span /></label>
                    <select name={`hours.${row.dayOfWeek}.openTime`} aria-label={`${row.day} opening time`} defaultValue={row.open || "08:00"}>{timeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
                    <span className="toLabel">to</span>
                    <select name={`hours.${row.dayOfWeek}.closeTime`} aria-label={`${row.day} closing time`} defaultValue={row.close || "18:00"}>{timeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
                  </div>
                ))}
              </div>
            </section>

            <div className="formFooter"><Link className="backLink" href="/welcome">←&nbsp;&nbsp;Back to welcome</Link><div className="formActions"><button type="submit" name="intent" value="save" className="outlineAction">Save for later</button><button type="submit" name="intent" value="continue" className="continueAction">Save &amp; Continue <ArrowRightIcon size={18} /></button></div></div>
          </form>
        </section>

        <aside className="businessSidebar">
          <SetupProgressPanel currentStep={1} initialStatus={setup} estimated="7 minutes" className="sidebarCard progressSidebarCard" progressClassName="sidebarProgressBar" />
          <section className="sidebarCard whyCard">
            <h2>Why this matters</h2>
            <p>Your business details, service area and hours help your AI assistant answer customer questions correctly, provide accurate information, and avoid booking errors.</p>
            <div className="whyBody">
              <div className="benefitList"><div className="benefitItem"><span className="benefitIcon green"><CheckIcon size={16} /></span><span>Gives accurate answers about your business</span></div><div className="benefitItem"><span className="benefitIcon purple"><UsersIcon size={16} /></span><span>Helps customers know if you&apos;re available</span></div><div className="benefitItem"><span className="benefitIcon blue"><CalendarIcon size={16} /></span><span>Prevents scheduling conflicts</span></div></div>
              <div className="storeIllustration" aria-hidden="true"><span className="illustrationNote">Accurate info.<br />Happier customers.</span><span className="mapPinBubble"><MapPinIcon size={22} /></span><div className="storeRoof" /><div className="storeAwning" /><div className="storeBody"><i /><i /></div></div>
            </div>
            <div className="editableNote"><span className="infoBubble"><InfoIcon size={18} /></span><div><strong>You can edit these details anytime from Settings.</strong><p>As your business grows, you can update your information, hours or service area at any time.</p></div></div>
          </section>
        </aside>
      </div>
    </main>
  );
}
