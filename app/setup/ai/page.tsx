import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  FileIcon,
  FlaskIcon,
  HelpIcon,
  InfoIcon,
  LinkIcon,
  LockIcon,
  LogoMark,
  PhoneIcon,
  RocketIcon,
  ShieldIcon,
  SparkleIcon,
  StoreIcon,
  UsersIcon,
} from "@/components/icons";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getAgentSetup, getBusinessSetup } from "@/server/domain/onboarding/repository";
import { saveAISetupAction } from "../actions";
import "./ai-assistant.css";

type ProgressStep = {
  number: number;
  title: string;
  description: string;
  tone: "blue" | "purple" | "green" | "orange";
  icon: ReactNode;
  state: "complete" | "active" | "locked";
};

const progressSteps: ProgressStep[] = [
  { number: 1, title: "Add your business", description: "Business details, hours and service area", tone: "blue", icon: <StoreIcon size={21} />, state: "complete" },
  { number: 2, title: "Teach your AI", description: "Services, FAQs and policies", tone: "purple", icon: <SparkleIcon size={21} />, state: "active" },
  { number: 3, title: "Connect communication", description: "Phone, SMS, WhatsApp and web chat", tone: "green", icon: <PhoneIcon size={20} />, state: "locked" },
  { number: 4, title: "Connect your calendar", description: "Google, Outlook, Calendly or Cal.com", tone: "orange", icon: <CalendarIcon size={20} />, state: "locked" },
  { number: 5, title: "Test your AI", description: "Run a chat or call test before going live", tone: "purple", icon: <FlaskIcon size={20} />, state: "locked" },
  { number: 6, title: "Go live", description: "Activate your assistant and start handling inquiries", tone: "blue", icon: <RocketIcon size={20} />, state: "locked" },
];

const defaultGuardrails = [
  "Never invent pricing",
  "Never confirm unavailable appointments",
  "Only answer based on approved business information",
  "Collect customer name and phone number before handing off",
];

export default async function AIAssistantSetupPage() {
  const context = await resolveWorkspaceContext(await headers());
  const [saved, business] = await Promise.all([
    getAgentSetup(context.workspace.id),
    getBusinessSetup(context.workspace.id),
  ]);
  const agent = saved.agent;
  const configuredGuardrails = agent?.behaviorSettings?.guardrails;
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
                <label className="aiField"><span>Primary goal</span><select name="primaryGoal" defaultValue={agent?.primaryGoal ?? "Book appointments"}><option>Book appointments</option><option>Capture leads</option><option>Answer questions</option><option>Combination</option></select></label>
                <label className="aiField"><span>Tone</span><select name="tone" defaultValue={agent?.tone ?? "Friendly & professional"}><option>Friendly &amp; professional</option><option>Professional</option><option>Casual</option></select></label>
                <label className="aiField"><span>When unsure</span><select name="fallback" defaultValue={agent?.whenUnsure ?? "Escalate to a human"}><option>Escalate to a human</option><option>Take a message</option></select></label>
                <label className="aiField summaryField"><span>Business summary</span><textarea name="summary" rows={2} defaultValue={business.profile?.summary ?? ""} /></label>
              </div>
            </section>

            <section className="aiSection knowledgeSection">
              <div className="sectionHeading">
                <span className="sectionIcon blue"><FileIcon size={22} /></span>
                <div><h2>Services &amp; FAQs</h2><p>Help your AI understand what you offer and the questions customers ask most.</p></div>
              </div>

              <div className="knowledgeGrid">
                <div className="serviceColumn">
                  <div className="miniSectionHeader"><strong>Services</strong><button type="button">+&nbsp; Add service</button></div>
                  <div className="serviceList">
                    {saved.services.length ? saved.services.map((service) => (
                      <div className="serviceRow" key={service.id}>
                        <span className="dragDots" aria-hidden="true">⠿</span>
                        <span>{service.name}</span>
                        <small>{service.priceText ?? "No price set"}</small>
                        <button className="moreButton" type="button" aria-label={`More options for ${service.name}`}>•••</button>
                      </div>
                    )) : <div className="serviceRow"><span>Add your first service using the API-backed editor.</span></div>}
                  </div>
                </div>

                <div className="faqColumn">
                  <div className="miniSectionHeader"><strong>Frequently asked questions</strong><button type="button">+&nbsp; Add FAQ</button></div>
                  <div className="faqList">
                    {saved.faqs.length ? saved.faqs.map((faq) => (
                      <details className="faqRow" key={faq.id}>
                        <summary>{faq.question}<ChevronRightIcon size={16} /></summary>
                        <p>{faq.answer}</p>
                      </details>
                    )) : <div className="faqRow"><p>Add approved FAQ answers for your assistant.</p></div>}
                  </div>
                </div>
              </div>
            </section>

            <section className="aiSection guardrailsSection">
              <div className="sectionHeading">
                <span className="sectionIcon blue"><ShieldIcon size={22} /></span>
                <div><h2>Policies &amp; guardrails</h2><p>Set the rules your AI should follow.</p></div>
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
                  <textarea name="escalationInstructions" rows={4} defaultValue={agent?.escalationMessage ?? "If the customer asks about special pricing, complaints, or anything uncertain, offer to connect them with the team."} />
                </label>
              </div>
            </section>

            <section className="aiSection importSection">
              <div className="sectionHeading">
                <span className="sectionIcon blue"><LinkIcon size={22} /></span>
                <div><h2>Import business knowledge</h2><p>Speed up setup by pulling information from your website or documents.</p></div>
              </div>

              <div className="importGrid">
                <div className="websiteImport">
                  <label className="aiField"><span>Website URL</span><input type="url" defaultValue={business.profile?.websiteUrl ?? ""} readOnly /></label>
                  <button type="button" className="importButton" disabled><LinkIcon size={16} /> Import from website</button>
                </div>
                <div className="fileUploadBlock">
                  <strong>Upload files</strong>
                  <label className="uploadDropzone">
                    <FileIcon size={20} />
                    <span>PDF, DOCX, TXT</span>
                    <span className="chooseFiles">Available in the knowledge milestone</span>
                  </label>
                </div>
              </div>
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
          <section className="sidebarCard aiProgressCard">
            <div className="sidebarProgressTop"><h2>Setup progress</h2><span>Estimated setup time: 7 minutes</span></div>
            <div className="sidebarProgressBar aiProgressBar"><span /></div>
            <div className="sidebarProgressMeta"><span>Step 2 of 6</span><strong>33%</strong></div>

            <div className="sidebarSteps">
              {progressSteps.map((step) => (
                <div className={`sidebarStep ${step.state}`} key={step.number}>
                  <span className="sidebarStepNumber">{step.number}</span>
                  <span className={`sidebarStepIcon ${step.tone}`}>
                    {step.state === "complete" ? <CheckIcon size={20} /> : step.icon}
                  </span>
                  <div><strong>{step.title}</strong><span>{step.description}</span></div>
                  {step.state === "locked" ? <LockIcon size={15} /> : <ChevronRightIcon size={18} />}
                </div>
              ))}
            </div>
          </section>

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
