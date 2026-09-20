"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  HelpIcon,
  LogoMark,
  MessageIcon,
  PhoneIcon,
} from "@/components/icons";
import { SetupProgressPanel, type SetupStatus } from "../setup-progress";
import "./test.css";

type TestKey = "phone" | "sms" | "whatsapp" | "webchat";
type SetupKey = keyof SetupStatus["steps"];


const setupRail: Array<{ key: SetupKey; label: string }> = [
  { key: "business", label: "Business\nDetails" },
  { key: "ai", label: "Teach\nYour AI" },
  { key: "communication", label: "Connect\nCommunication" },
  { key: "calendar", label: "Connect\nCalendar" },
  { key: "test", label: "Test &\nGo Live" },
  { key: "live", label: "All Set!" },
];

export default function TestSetupPage() {
  const [phone, setPhone] = useState<{ phoneNumber: string; status: string; messagingReadiness: string } | null>(null);
  const [webChatEmbedCode, setWebChatEmbedCode] = useState("");
  const [channelError, setChannelError] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/phone-numbers", { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error("Phone status unavailable."); return response.json(); })
      .then((payload) => setPhone(payload.number ?? null))
      .catch((error) => setChannelError(error instanceof Error ? error.message : "Phone status unavailable."));
    fetch("/api/widget/config", { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error("Web Chat status unavailable."); return response.json(); })
      .then((payload) => setWebChatEmbedCode(payload.embedCode ?? ""))
      .catch((error) => setChannelError(error instanceof Error ? error.message : "Web Chat status unavailable."));
    fetch("/api/agent", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => { if (payload?.agent?.status === "ACTIVE") setIsLive(true); })
      .catch(() => undefined);
    fetch("/api/setup/status", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => { if (payload?.setup) setSetup(payload.setup as SetupStatus); })
      .catch(() => undefined);
  }, []);

  const activate = async () => {
    if (activating || isLive) return;
    setActivating(true);
    setActivationError(null);
    try {
      const response = await fetch("/api/agent/status", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "ACTIVE" }),
      });
      const result = await response.json() as { agent?: { status: string }; error?: { message?: string } };
      if (!response.ok || result.agent?.status !== "ACTIVE") {
        throw new Error(result.error?.message ?? "Unable to activate your AI Agent.");
      }
      setIsLive(true);
    } catch (error) {
      setActivationError(error instanceof Error ? error.message : "Unable to activate your AI Agent.");
    } finally {
      setActivating(false);
    }
  };

  const runTest = (key: TestKey) => {
    // This page does not yet have a channel-specific provider test runner.
    // Never claim a call, SMS or WhatsApp delivery passed based on a timer.
    setActivationError(`${key.toUpperCase()} live testing is not available from this page; use the connected channel directly or the AI Agent private Web Chat test.`);
  };

  const copyNumber = async () => {
    if (!phone?.phoneNumber) return;
    try { await navigator.clipboard.writeText(phone.phoneNumber); setCopied(true); window.setTimeout(() => setCopied(false), 1400); } catch { setCopied(false); }
  };

  const copyEmbedCode = async () => {
    try { await navigator.clipboard.writeText(webChatEmbedCode); setCopiedEmbed(true); window.setTimeout(() => setCopiedEmbed(false), 1400); } catch { setCopiedEmbed(false); }
  };

  const readyLabel = (key: TestKey) => key === "phone"
    ? phone?.status === "ACTIVE" ? "Ready for manual call test" : "Number not active"
    : key === "sms" ? phone?.messagingReadiness === "READY" ? "Eligible for outbound SMS tests" : "Outbound SMS not ready"
    : "Manual verification required";

  return (
    <main className="testSetupPage">
      <header className="siteHeader testSetupHeader">
        <Link className="brandMini" href="/welcome" aria-label="AI Caller home"><LogoMark size={35} /><strong>AI Caller</strong></Link>
        <a className="supportLink" href="mailto:support@aicaller.com"><HelpIcon size={17} /><span>Need help?</span><strong>Contact support</strong></a>
      </header>

      <div className="testSetupGrid">
        <section className="testMainCard">
          <div className="testIntro"><span className="testStepBadge">STEP 5 OF 6</span><h1>Test your AI assistant</h1><p>Make sure everything is working perfectly before you go live.</p><span>Run a few tests to check your AI assistant can handle calls, messages and book appointments.</span></div>

          <div className="setupRail" aria-label="Onboarding progress">
            {setupRail.map((item, index) => {
              const complete = Boolean(setup?.steps[item.key]);
              const active = item.key === "test" && !complete;
              const next = item.key === "live" && !complete;
              return <div className={`railItem ${active ? "active" : ""} ${next ? "next" : ""}`} key={item.key}><div className="railDot">{complete ? <CheckIcon size={17} /> : <b>{index + 1}</b>}</div><strong>{item.label.split("\n").map((line) => <span key={line}>{line}</span>)}</strong></div>;
            })}
          </div>

          <TestCard tone="blue" icon={<PhoneIcon size={23} />} title="Test a phone call" description="Call your AI assistant to see how it handles inquiries, answers questions and books appointments." status={readyLabel("phone")} statusState="ready">
            <div className="testActionRow"><div className="testNumberBlock"><small>Call this number from your phone</small><strong>{phone?.phoneNumber ?? "No managed number configured"}</strong><button type="button" disabled={!phone?.phoneNumber} onClick={copyNumber}>{copied ? "Copied" : "Copy"}</button></div><span className="orText">or</span><button type="button" className="secondaryTestButton" onClick={() => runTest("phone")}><PhoneIcon size={16} /> How to test</button></div><TipRow>Try asking about your services, pricing or book an appointment.</TipRow>
          </TestCard>

          <TestCard tone="blue" icon={<MessageIcon size={22} />} title="Test an SMS conversation" description="Send a text to your AI assistant and see how it responds." status={readyLabel("sms")} statusState="ready">
            <div className="testActionRow"><div className="testNumberBlock"><small>Text this number</small><strong>{phone?.phoneNumber ?? "No managed number configured"}</strong><button type="button" disabled={!phone?.phoneNumber} onClick={copyNumber}>{copied ? "Copied" : "Copy"}</button></div><span className="orText">or</span><button type="button" className="secondaryTestButton" onClick={() => runTest("sms")}><MessageIcon size={16} /> How to test</button></div><TipRow>Try asking a question or request an appointment.</TipRow>
          </TestCard>

          <TestCard tone="green" icon={<MessageIcon size={23} />} title="Test a WhatsApp conversation" description="Send a WhatsApp message to your AI assistant." status={readyLabel("whatsapp")} statusState="ready">
            <div className="testActionRow"><div className="testNumberBlock"><small>Message this number on WhatsApp</small><strong>Use the sender shown in your WhatsApp integration settings</strong></div><span className="orText">or</span><button type="button" className="secondaryTestButton whatsappButton" onClick={() => runTest("whatsapp")}><MessageIcon size={16} /> How to test</button></div><TipRow>Try asking about your availability or book a time.</TipRow>
          </TestCard>

          <TestCard tone="blue" icon={<MessageIcon size={23} />} title="Test the web chat" description="Use the chat widget to have a conversation with your AI assistant." status={readyLabel("webchat")} statusState="ready">
            <div className="webChatEmbedBlock"><div className="webChatEmbedHeading"><div><strong>Web chat embed code</strong><small>Paste this snippet just before the closing &lt;/body&gt; tag on your website.</small></div></div><div className="webChatEmbedField"><input aria-label="Web chat embed code" readOnly value={webChatEmbedCode} /><button type="button" disabled={!webChatEmbedCode} onClick={copyEmbedCode} aria-label="Copy web chat embed code" title="Copy embed code"><span className="copyGlyph">⧉</span><span>{copiedEmbed ? "Copied" : "Copy"}</span></button></div></div>
            <div className="webChatActions"><Link className="primaryTestButton" href="/ai-agent">Open private AI Agent test</Link><button type="button" className="secondaryTestButton" onClick={() => runTest("webchat")}>How to test</button></div><TipRow>Try asking a few questions and book an appointment.</TipRow>
          </TestCard>

          {(activationError || channelError) && <div role="alert" className="readyBanner"><p>{activationError || channelError}</p></div>}
          <div className={`readyBanner ${isLive ? "live" : ""}`}><span className="readyCheck"><CheckIcon size={22} /></span><div><strong>{isLive ? "Agent activated" : "Activate when ready"}</strong><p>{isLive ? "Your AI agent is active; channel availability and SMS compliance are managed separately." : "Complete your own channel checks, then activate the AI agent. This screen does not verify live carrier delivery."}</p></div></div>

          <div className="testFooter"><Link className="backLink" href="/setup/calendar">←&nbsp;&nbsp;Back to Calendar</Link><div className="testActions"><button type="button" className="outlineAction">Save for later</button><button type="button" className="goLiveButton" disabled={activating || isLive} onClick={() => void activate()}>{activating ? "Activating…" : isLive ? "Live" : "Go Live"} <ChevronRightIcon size={18} /></button></div></div>
        </section>

        <aside className="testSidebar">
          <SetupProgressPanel currentStep={5} initialStatus={setup ?? undefined} estimated="2 minutes" className="sidebarCard testProgressCard" progressClassName="sidebarProgressBar" />
          <section className="sidebarCard whatToTestCard"><h2>What to test</h2><GuideItem icon={<PhoneIcon size={17} />} title="Ask general questions">e.g. “What are your hours?” or “What services do you offer?”</GuideItem><GuideItem icon={<CalendarIcon size={17} />} title="Book an appointment">e.g. “I’d like to book a consultation for next week.”</GuideItem><GuideItem icon={<HelpIcon size={17} />} title="Test different scenarios">Try asking about pricing, rescheduling or cancellation.</GuideItem><GuideItem icon={<MessageIcon size={17} />} title="Check response quality">Make sure the answers are accurate and helpful.</GuideItem></section>

          <section className="sidebarCard readyCard"><div className="readyCardCopy"><h2>Get ready to never<br />miss a customer again.</h2><p>Your AI assistant will be available 24/7 to answer questions, book appointments and help grow your business.</p><ul><li><CheckIcon size={13} /> Responds instantly</li><li><CheckIcon size={13} /> Books appointments automatically</li><li><CheckIcon size={13} /> Works across phone, SMS, WhatsApp and web</li><li><CheckIcon size={13} /> Saves you time and helps you get more customers</li></ul></div><div className="robotArt" aria-hidden="true"><span className="robotNote top">Almost there!</span><div className="robotHead"><i className="eye left" /><i className="eye right" /><b className="robotSmile" /></div><div className="robotBody"><LogoMark size={27} /></div><span className="robotArm left" /><span className="robotArm right" /><span className="robotNote bottom">You’re all set<br />to go live!</span></div></section>

          <section className="helpCard"><span className="helpBubble"><HelpIcon size={19} /></span><div><strong>Need help?</strong><p>Our team is here to help you get set up.</p></div><a href="mailto:support@aicaller.com">Contact support</a></section>
        </aside>
      </div>
    </main>
  );
}

function TestCard({ tone, icon, title, description, status, statusState, children }: { tone: "blue" | "green"; icon: ReactNode; title: string; description: string; status: string; statusState: "ready" | "running" | "done"; children: ReactNode }) {
  return <section className="testCard"><div className="testCardHeading"><span className={`testCardIcon ${tone}`}>{icon}</span><div><h2>{title}</h2><p>{description}</p></div><span className={`testStatus ${statusState}`}><i />{status}</span></div>{children}</section>;
}
function TipRow({ children }: { children: ReactNode }) { return <div className="tipRow"><span>💡</span><p>{children}</p></div>; }
function GuideItem({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) { return <div className="guideItem"><span>{icon}</span><div><strong>{title}</strong><p>{children}</p></div></div>; }
