import Link from "next/link";
import { headers } from "next/headers";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  FileIcon,
  HelpIcon,
  InfoIcon,
  LinkIcon,
  LogoMark,
  ShieldIcon,
  SparkleIcon,
  UsersIcon,
} from "@/components/icons";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { listVoiceProfiles } from "@/server/voice/voices";
import { getAgentSetup, getBusinessSetup, getSetupStatus } from "@/server/domain/onboarding/repository";
import { saveAISetupAction } from "../actions";
import { SetupProgressPanel } from "../setup-progress";
import { KnowledgeEditor } from "./knowledge-editor";
import { KnowledgeImportEditor } from "./knowledge-import-editor";
import { QualificationEditor } from "./qualification-editor";
import "./ai-assistant.css";

const defaultGuardrails = [
  "Never invent pricing",
  "Never confirm unavailable appointments",
  "Only answer based on approved business information",
  "Collect customer name and phone number before handing off",
];

export default async function AIAssistantSetupPage() {
  const context = await resolveWorkspaceContext(await headers());
  const [saved, business, setup] = await Promise.all([
    getAgentSetup(context.workspace.id),
    getBusinessSetup(context.workspace.id),
    getSetupStatus(context.workspace.id),
  ]);
  const agent = saved.agent;
  const voiceProfiles = listVoiceProfiles();
  const configuredGuardrails = agent?.behaviorSettings?.guardrails;
  const voiceSettings = agent?.behaviorSettings?.voice && typeof agent.behaviorSettings.voice === "object" ? agent.behaviorSettings.voice as Record<string, unknown> : {};
  const qualificationSettings = agent?.behaviorSettings?.qualification && typeof agent.behaviorSettings.qualification === "object" ? agent.behaviorSettings.qualification as { enabled?: boolean; criteria?: Array<{ id: string; label: string; question: string; required: boolean }> } : null;
  const guardrails = Array.isArray(configuredGuardrails) && configuredGuardrails.every((item) => typeof item === "string")
    ? configuredGuardrails as string[]
    : defaultGuardrails;

  return (
    <main className="aiSetupPage">
      <header className="siteHeader aiSetupHeader">
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

      <div className="aiSetupGrid">
        <section className="aiFormCard">
          <div className="aiIntro">
            <span className="stepBadge">STEP 2 OF 6</span>
            <h1>Teach your AI</h1>
            <p>Tell your AI how your business works so it can answer customer questions accurately<br className="desktopBreak" /> and guide people toward booking.</p>
          </div>

          <form className="aiSetupForm" action={saveAISetupAction}>
            <section className="aiSection basicsSection">
              <div className="sectionHeading">
                <span className="sectionIcon purple"><SparkleIcon size={22} /></span>
                <div><h2>Assistant basics</h2><p>Define your assistant&apos;s identity and how it should communicate.</p></div>
              </div>

              <div className="aiFieldGrid twoColumns">
                <label className="aiField"><span>Assistant name</span><input name="assistantName" defaultValue={agent?.name ?? "Mia"} required /></label>
                <label className="aiField"><span>Primary goal</span><select name="primaryGoal" defaultValue={agent?.primaryGoal ?? "Book appointments"}><option>Book appointments</option><option>Capture leads</option><option>Answer questions</option><option>Combination</option></select><small>This sets the assistant&apos;s priority; it can still handle the other configured tasks.</small></label>
                <label className="aiField"><span>Tone</span><select name="tone" defaultValue={agent?.tone ?? "Friendly & professional"}><option>Friendly &amp; professional</option><option>Professional</option><option>Casual</option></select></label>
                <label className="aiField"><span>When unsure</span><select name="fallback" defaultValue={agent?.whenUnsure ?? "Escalate to a human"}><option>Escalate to a human</option><option>Take a message</option></select><small>This chooses the fallback action. Escalation instructions below define when and how to hand off.</small></label>
                <label className="aiField summaryField"><span>Business summary</span><textarea name="summary" rows={2} defaultValue={business.profile?.summary ?? ""} /></label>
              </div>
            </section>

            <section className="aiSection voiceSection">
              <div className="sectionHeading">
                <span className="sectionIcon green"><SparkleIcon size={22} /></span>
                <div><h2>Voice &amp; call behavior</h2><p>Choose how your assistant sounds on inbound phone calls.</p></div>
              </div>
              <div className="voiceSetupGrid">
                <label className="aiField"><span>Preferred voice</span><select name="voiceProfile" defaultValue={typeof voiceSettings.profileKey === "string" ? voiceSettings.profileKey : "ava-us-1"}>{voiceProfiles.map((voice) => <option value={voice.key} key={voice.key}>{voice.displayName} — {voice.description.toLowerCase()}</option>)}</select></label>
                <label className="aiField"><span>Language</span><select name="voiceLanguage" defaultValue={typeof voiceSettings.language === "string" ? voiceSettings.language : "en-US"}><option value="en-US">English (US)</option><option value="en-GB">English (UK)</option><option value="es-US">Spanish (US)</option></select></label>
                <label className="aiField"><span>Speaking speed</span><select name="voiceSpeed" defaultValue={String(typeof voiceSettings.speakingRate === "number" ? voiceSettings.speakingRate : 1)}><option value="0.85">Relaxed</option><option value="1">Natural</option><option value="1.15">Brisk</option></select></label>
                <label className="aiField"><span>Recording consent</span><select name="recordingPolicy" defaultValue={typeof voiceSettings.recordingPolicy === "string" ? voiceSettings.recordingPolicy : "ANNOUNCE"}><option value="ANNOUNCE">Announce recording before it starts</option><option value="EXPLICIT_CONSENT">Require explicit consent</option></select></label><label className="aiField"><span>After-hours handling</span><select name="afterHoursEnabled" defaultValue={voiceSettings.afterHoursEnabled === false ? "off" : "on"}><option value="on">AI answers using after-hours context</option><option value="off">Use AI First behavior at all hours</option></select></label>
              </div>
              <p className="voiceSetupNote">Inbound calls only. The recording is the primary Inbox artifact and the synchronized transcript is available on demand.</p>
            </section>

            <section className="aiSection knowledgeSection">
              <div className="sectionHeading">
                <span className="sectionIcon blue"><FileIcon size={22} /></span>
                <div><h2>Services, FAQs &amp; policies</h2><p>Give your AI approved business knowledge it can use in customer conversations.</p></div>
              </div>
              <KnowledgeEditor initialServices={saved.services} initialFaqs={saved.faqs} initialPolicies={saved.policies} />
            </section>

            <section className="aiSection guardrailsSection">
              <div className="sectionHeading">
                <span className="sectionIcon blue"><ShieldIcon size={22} /></span>
                <div><h2>Guardrails</h2><p>Set the rules your AI should follow.</p></div>
              </div>

              <div className="guardrailsGrid">
                <div className="guardrailList">
                  {defaultGuardrails.map((rule) => (
                    <label className="guardrailRow" key={rule}>
                      <span className="toggle"><input name="guardrails" value={rule} type="checkbox" defaultChecked={guardrails.includes(rule)} /><span /></span>
                      <span>{rule}</span>
                    </label>
                  ))}
                </div>
                <label className="aiField escalationField">
                  <span>Escalation instructions</span>
                  <small>Used with the “When unsure” fallback and for requests that need a human.</small>
                  <textarea name="escalationInstructions" rows={4} defaultValue={agent?.escalationMessage ?? "If the customer asks about special pricing, complaints, or anything uncertain, offer to connect them with the team."} />
                </label>
              </div>
            </section>

            <section className="aiSection qualificationSection">
              <div className="sectionHeading">
                <span className="sectionIcon orange"><UsersIcon size={22} /></span>
                <div><h2>Lead qualification</h2><p>Define the information every channel should collect before a lead is considered qualified.</p></div>
              </div>
              <QualificationEditor initial={qualificationSettings} />
            </section>

            <section className="aiSection importSection">
              <div className="sectionHeading">
                <span className="sectionIcon blue"><LinkIcon size={22} /></span>
                <div><h2>Import business knowledge</h2><p>Speed up setup by pulling information from your website or documents.</p></div>
              </div>

              <KnowledgeImportEditor initialWebsite={business.profile?.websiteUrl ?? ""} />
            </section>

            <div className="aiFormFooter">
              <Link className="backLink" href="/setup/business">←&nbsp;&nbsp;Back to business profile</Link>
              <div className="formActions">
                <button type="submit" name="intent" value="save" className="outlineAction">Save for later</button>
                <button type="submit" name="intent" value="continue" className="continueAction">Save &amp; Continue <ChevronRightIcon size={18} /></button>
              </div>
            </div>
          </form>
        </section>

        <aside className="aiSidebar">
          <SetupProgressPanel currentStep={2} estimated="7 minutes" initialStatus={setup} className="sidebarCard aiProgressCard" progressClassName="sidebarProgressBar aiProgressBar" />

          <section className="sidebarCard aiWhyCard">
            <h2>Why this matters</h2>
            <p>Your AI needs accurate services, FAQs, and rules to respond consistently, represent your brand, and guide customers toward booking with confidence.</p>

            <div className="aiWhyBody">
              <div className="benefitList">
                <div className="benefitItem"><span className="benefitIcon green"><CheckIcon size={16} /></span><span>Answers common customer questions instantly</span></div>
                <div className="benefitItem"><span className="benefitIcon purple"><UsersIcon size={16} /></span><span>Represents your brand the right way</span></div>
                <div className="benefitItem"><span className="benefitIcon blue"><CalendarIcon size={16} /></span><span>Books with more confidence and fewer mistakes</span></div>
              </div>

              <div className="assistantIllustration" aria-hidden="true">
                <span className="illustrationNote">Clear answers.<br />Better conversations.</span>
                <div className="chatSpark"><SparkleIcon size={30} /></div>
                <div className="chatCard"><i /><i /><i /></div>
                <span className="leaf left" /><span className="leaf right" />
              </div>
            </div>

            <div className="editableNote">
              <span className="infoBubble"><InfoIcon size={18} /></span>
              <div><strong>You can refine your AI anytime from Settings.</strong><p>As your business grows, you can update your services, FAQs, rules, or import new information at any time.</p></div>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
