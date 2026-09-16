"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  HelpIcon,
  InfoIcon,
  LogoMark,
  MessageIcon,
  PhoneIcon,
  RocketIcon,
  SparkleIcon,
  StoreIcon,
  UsersIcon,
} from "@/components/icons";
import "./test.css";

type TestKey = "phone" | "sms" | "whatsapp" | "webchat";

type ProgressStep = {
  number: number;
  title: string;
  description: string;
  icon: ReactNode;
  state: "complete" | "active" | "next";
};

const testNumber = "+1 (555) 123-4567";

const progressSteps: ProgressStep[] = [
  { number: 1, title: "Add your business", description: "Business details, hours and service area", icon: <StoreIcon size={19} />, state: "complete" },
  { number: 2, title: "Teach your AI", description: "Services, FAQs and policies", icon: <SparkleIcon size={19} />, state: "complete" },
  { number: 3, title: "Connect communication", description: "Phone, SMS, WhatsApp and web chat", icon: <MessageIcon size={19} />, state: "complete" },
  { number: 4, title: "Connect your calendar", description: "Google, Outlook, Calendly or Cal.com", icon: <CalendarIcon size={19} />, state: "complete" },
  { number: 5, title: "Test & Go Live", description: "Test your setup and activate", icon: <MessageIcon size={19} />, state: "active" },
  { number: 6, title: "All Set!", description: "You’re ready to start receiving inquiries", icon: <RocketIcon size={19} />, state: "next" },
];

const setupRail = [
  { label: "Business\nDetails", complete: true },
  { label: "Teach\nYour AI", complete: true },
  { label: "Connect\nCommunication", complete: true },
  { label: "Connect\nCalendar", complete: true },
  { label: "Test &\nGo Live", active: true },
  { label: "All Set!", next: true },
];

export default function TestSetupPage() {
  const [status, setStatus] = useState<Record<TestKey, "ready" | "running" | "done">>({
    phone: "ready",
    sms: "ready",
    whatsapp: "ready",
    webchat: "ready",
  });
  const [copied, setCopied] = useState(false);
  const [isLive, setIsLive] = useState(false);

  const runTest = (key: TestKey) => {
    setStatus((current) => ({ ...current, [key]: "running" }));
    window.setTimeout(() => setStatus((current) => ({ ...current, [key]: "done" })), 700);
  };

  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText(testNumber);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const readyLabel = (key: TestKey) => {
    const value = status[key];
    if (value === "running") return "Testing...";
    if (value === "done") return "Test passed";
    return "Ready to test";
  };

  return (
    <main className="testSetupPage">
      <header className="siteHeader testSetupHeader">
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

      <div className="testSetupGrid">
        <section className="testMainCard">
          <div className="testIntro">
            <span className="testStepBadge">STEP 5 OF 6</span>
            <h1>Test your AI assistant</h1>
            <p>Make sure everything is working perfectly before you go live.</p>
            <span>Run a few tests to check your AI assistant can handle calls, messages and book appointments.</span>
          </div>

          <div className="setupRail" aria-label="Onboarding progress">
            {setupRail.map((item, index) => (
              <div className={`railItem ${item.active ? "active" : ""} ${item.next ? "next" : ""}`} key={item.label}>
                <div className="railDot">
                  {item.complete ? <CheckIcon size={17} /> : <b>{index + 1}</b>}
                </div>
                <strong>{item.label.split("\n").map((line) => <span key={line}>{line}</span>)}</strong>
              </div>
            ))}
          </div>

          <TestCard
            tone="blue"
            icon={<PhoneIcon size={23} />}
            title="Test a phone call"
            description="Call your AI assistant to see how it handles inquiries, answers questions and books appointments."
            status={readyLabel("phone")}
            statusState={status.phone}
          >
            <div className="testActionRow">
              <div className="testNumberBlock"><small>Call this number from your phone</small><strong>{testNumber}</strong><button type="button" onClick={copyNumber}>{copied ? "Copied" : "Copy"}</button></div>
              <span className="orText">or</span>
              <button type="button" className="secondaryTestButton" onClick={() => runTest("phone")}><PhoneIcon size={16} /> Call me now</button>
            </div>
            <TipRow>Try asking about your services, pricing or book an appointment.</TipRow>
          </TestCard>

          <TestCard
            tone="blue"
            icon={<MessageIcon size={22} />}
            title="Test an SMS conversation"
            description="Send a text to your AI assistant and see how it responds."
            status={readyLabel("sms")}
            statusState={status.sms}
          >
            <div className="testActionRow">
              <div className="testNumberBlock"><small>Text this number</small><strong>{testNumber}</strong><button type="button" onClick={copyNumber}>{copied ? "Copied" : "Copy"}</button></div>
              <span className="orText">or</span>
              <button type="button" className="secondaryTestButton" onClick={() => runTest("sms")}><MessageIcon size={16} /> Send me a test SMS</button>
            </div>
            <TipRow>Try asking a question or request an appointment.</TipRow>
          </TestCard>

          <TestCard
            tone="green"
            icon={<MessageIcon size={23} />}
            title="Test a WhatsApp conversation"
            description="Send a WhatsApp message to your AI assistant."
            status={readyLabel("whatsapp")}
            statusState={status.whatsapp}
          >
            <div className="testActionRow">
              <div className="testNumberBlock"><small>Message this number on WhatsApp</small><strong>{testNumber}</strong><button type="button" onClick={copyNumber}>{copied ? "Copied" : "Copy"}</button></div>
              <span className="orText">or</span>
              <button type="button" className="secondaryTestButton whatsappButton" onClick={() => runTest("whatsapp")}><MessageIcon size={16} /> Open in WhatsApp</button>
            </div>
            <TipRow>Try asking about your availability or book a time.</TipRow>
          </TestCard>

          <TestCard
            tone="blue"
            icon={<MessageIcon size={23} />}
            title="Test the web chat"
            description="Use the chat widget to have a conversation with your AI assistant."
            status={readyLabel("webchat")}
            statusState={status.webchat}
          >
            <div className="webChatActions">
              <button type="button" className="primaryTestButton" onClick={() => runTest("webchat")}>Open chat widget ↗</button>
              <button type="button" className="secondaryTestButton" onClick={() => runTest("webchat")}>Preview on your website ↗</button>
            </div>
            <TipRow>Try asking a few questions and book an appointment.</TipRow>
          </TestCard>

          <div className={`readyBanner ${isLive ? "live" : ""}`}>
            <span className="readyCheck"><CheckIcon size={22} /></span>
            <div>
              <strong>{isLive ? "You’re live!" : "Everything looks good!"}</strong>
              <p>{isLive ? "Your AI assistant is active and ready to start handling customer inquiries." : "Your AI assistant is ready to go live. When you’re ready, click the button below to activate it."}</p>
            </div>
          </div>

          <div className="testFooter">
            <Link className="backLink" href="/setup/calendar">←&nbsp;&nbsp;Back to Calendar</Link>
            <div className="testActions">
              <button type="button" className="outlineAction">Save for later</button>
              <button type="button" className="goLiveButton" onClick={() => setIsLive(true)}>{isLive ? "Live" : "Go Live"} <ChevronRightIcon size={18} /></button>
            </div>
          </div>
        </section>

        <aside className="testSidebar">
          <section className="sidebarCard testProgressCard">
            <div className="sidebarProgressTop"><h2>Setup progress</h2><span>Estimated setup time: 2 minutes</span></div>
            <div className="sidebarProgressBar"><span /></div>
            <div className="sidebarProgressMeta"><span>5 of 6 completed</span><strong>83%</strong></div>
            <div className="sidebarSteps">
              {progressSteps.map((step) => (
                <div className={`sidebarStep ${step.state}`} key={step.number}>
                  <span className="sidebarStepNumber">{step.number}</span>
                  <span className="sidebarStepIcon">{step.state === "complete" ? <CheckIcon size={19} /> : step.icon}</span>
                  <div><strong>{step.title}</strong><span>{step.description}</span></div>
                  {step.state !== "next" && <ChevronRightIcon size={17} />}
                </div>
              ))}
            </div>
          </section>

          <section className="sidebarCard whatToTestCard">
            <h2>What to test</h2>
            <GuideItem icon={<PhoneIcon size={17} />} title="Ask general questions">e.g. “What are your hours?” or “What services do you offer?”</GuideItem>
            <GuideItem icon={<CalendarIcon size={17} />} title="Book an appointment">e.g. “I’d like to book a consultation for next week.”</GuideItem>
            <GuideItem icon={<HelpIcon size={17} />} title="Test different scenarios">Try asking about pricing, rescheduling or cancellation.</GuideItem>
            <GuideItem icon={<MessageIcon size={17} />} title="Check response quality">Make sure the answers are accurate and helpful.</GuideItem>
          </section>

          <section className="sidebarCard readyCard">
            <div className="readyCardCopy">
              <h2>Get ready to never<br />miss a customer again.</h2>
              <p>Your AI assistant will be available 24/7 to answer questions, book appointments and help grow your business.</p>
              <ul>
                <li><CheckIcon size={13} /> Responds instantly</li>
                <li><CheckIcon size={13} /> Books appointments automatically</li>
                <li><CheckIcon size={13} /> Works across phone, SMS, WhatsApp and web</li>
                <li><CheckIcon size={13} /> Saves you time and helps you get more customers</li>
              </ul>
            </div>
            <div className="robotArt" aria-hidden="true">
              <span className="robotNote top">Almost there!</span>
              <div className="robotHead"><i className="eye left" /><i className="eye right" /><b className="robotSmile" /></div>
              <div className="robotBody"><LogoMark size={27} /></div>
              <span className="robotArm left" /><span className="robotArm right" />
              <span className="robotNote bottom">You’re all set<br />to go live!</span>
            </div>
          </section>

          <section className="helpCard">
            <span className="helpBubble"><HelpIcon size={19} /></span>
            <div><strong>Need help?</strong><p>Our team is here to help you get set up.</p></div>
            <a href="mailto:support@aicaller.com">Contact support</a>
          </section>
        </aside>
      </div>
    </main>
  );
}

function TestCard({ tone, icon, title, description, status, statusState, children }: { tone: "blue" | "green"; icon: ReactNode; title: string; description: string; status: string; statusState: "ready" | "running" | "done"; children: ReactNode }) {
  return (
    <section className="testCard">
      <div className="testCardHeading">
        <span className={`testCardIcon ${tone}`}>{icon}</span>
        <div><h2>{title}</h2><p>{description}</p></div>
        <span className={`testStatus ${statusState}`}><i />{status}</span>
      </div>
      {children}
    </section>
  );
}

function TipRow({ children }: { children: ReactNode }) {
  return <div className="tipRow"><span>💡</span><p>{children}</p></div>;
}

function GuideItem({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="guideItem"><span>{icon}</span><div><strong>{title}</strong><p>{children}</p></div></div>;
}
