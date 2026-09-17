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
import "./business-profile.css";

const defaultDays = [
  { day: "Monday", open: "8:00 AM", close: "6:00 PM", enabled: true },
  { day: "Tuesday", open: "8:00 AM", close: "6:00 PM", enabled: true },
  { day: "Wednesday", open: "8:00 AM", close: "6:00 PM", enabled: true },
  { day: "Thursday", open: "8:00 AM", close: "6:00 PM", enabled: true },
  { day: "Friday", open: "8:00 AM", close: "6:00 PM", enabled: true },
  { day: "Saturday", open: "9:00 AM", close: "3:00 PM", enabled: true },
  { day: "Sunday", open: "", close: "", enabled: false },
];

export default async function BusinessProfilePage() {
  const context = await resolveWorkspaceContext(await headers());
  const [saved, setup] = await Promise.all([
    getBusinessSetup(context.workspace.id),
    getSetupStatus(context.workspace.id),
  ]);
  const hourMap = new Map(saved.hours.map((row) => [row.dayOfWeek, row]));
  const days = defaultDays.map((day, index) => {
    const stored = hourMap.get(index);
    return stored ? { day: day.day, open: stored.openTime ?? day.open, close: stored.closeTime ?? day.close, enabled: stored.enabled } : day;
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
                <label className="businessField"><span>Industry</span><select name="industry" defaultValue={profile?.industry ?? "Other"}><option>Auto Repair</option><option>Plumbing</option><option>HVAC</option><option>Roofing</option><option>Dental</option><option>Med Spa</option><option>Cleaning</option><option>Other</option></select></label>
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
                <label className="timezoneField"><span>Timezone</span><input name="timezone" defaultValue={profile?.timezone ?? "UTC"} /></label>
              </div>
              <div className="hoursTable">
                {days.map((row, index) => (
                  <div className={`hoursRow ${!row.enabled ? "closed" : ""}`} key={row.day}>
                    <strong>{row.day}</strong>
                    <label className="toggle" aria-label={`${row.day} open`}><input name={`hours.${index}.enabled`} type="checkbox" defaultChecked={row.enabled} /><span /></label>
                    <select name={`hours.${index}.openTime`} aria-label={`${row.day} opening time`} defaultValue={row.open || "8:00 AM"}><option>8:00 AM</option><option>9:00 AM</option><option>10:00 AM</option></select>
                    <span className="toLabel">to</span>
                    <select name={`hours.${index}.closeTime`} aria-label={`${row.day} closing time`} defaultValue={row.close || "6:00 PM"}><option>3:00 PM</option><option>5:00 PM</option><option>6:00 PM</option><option>7:00 PM</option></select>
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
