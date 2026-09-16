import type { ReactNode } from "react";
import Link from "next/link";
import "./welcome.css";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  FlaskIcon,
  GearIcon,
  HelpIcon,
  InfoIcon,
  LockIcon,
  LogoMark,
  MessageIcon,
  PhoneIcon,
  RocketIcon,
  SparkleIcon,
  StoreIcon,
} from "@/components/icons";

type SetupStep = {
  number: number;
  title: string;
  description: string;
  status: "Not started" | "Locked";
  tone: string;
  icon: ReactNode;
};

const setupSteps: SetupStep[] = [
  {
    number: 1,
    title: "Add your business",
    description: "Business details, hours and service area",
    status: "Not started",
    tone: "blue",
    icon: <StoreIcon size={23} />,
  },
  {
    number: 2,
    title: "Teach your AI",
    description: "Services, FAQs and policies",
    status: "Not started",
    tone: "purple",
    icon: <SparkleIcon size={23} />,
  },
  {
    number: 3,
    title: "Connect communication",
    description: "Phone, SMS, WhatsApp and web chat",
    status: "Not started",
    tone: "green",
    icon: <PhoneIcon size={22} />,
  },
  {
    number: 4,
    title: "Connect your calendar",
    description: "Google, Outlook, Calendly or Cal.com",
    status: "Not started",
    tone: "orange",
    icon: <CalendarIcon size={22} />,
  },
  {
    number: 5,
    title: "Test your AI",
    description: "Run a chat or call test before going live",
    status: "Locked",
    tone: "purple",
    icon: <FlaskIcon size={22} />,
  },
  {
    number: 6,
    title: "Go live",
    description: "Activate your assistant and start handling inquiries",
    status: "Locked",
    tone: "blue",
    icon: <RocketIcon size={22} />,
  },
];

function SetupRowContent({ step }: { step: SetupStep }) {
  return (
    <>
      <span className="stepNumber">{step.number}</span>
      <span className={`stepIcon ${step.tone}`}>{step.icon}</span>
      <span className="stepCopy">
        <strong>{step.title}</strong>
        <span>{step.description}</span>
      </span>
      <span className={`statusPill ${step.status === "Locked" ? "locked" : ""}`}>
        {step.status === "Locked" ? <LockIcon size={13} /> : <i />}
        {step.status}
      </span>
      <ChevronRightIcon className="stepChevron" size={20} />
    </>
  );
}

export default function WelcomePage() {
  return (
    <main className="welcomePage">
      <header className="siteHeader welcomeHeader">
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

      <section className="welcomeFrame">
        <div className="welcomeMain">
          <div className="welcomeHeroCopy">
            <span className="eyebrow">WELCOME TO AI CALLER</span>
            <h1>Let&apos;s get your AI Customer<br />Assistant live.</h1>
            <p>Complete the setup below to start handling customer inquiries<br className="desktopBreak" /> and booking appointments.</p>
          </div>

          <div className="progressCard">
            <div className="progressMeta">
              <strong>Setup progress</strong>
              <span>Estimated setup time: 7 minutes</span>
            </div>
            <div className="progressLineRow">
              <div className="progressTrack"><span style={{ width: "0%" }} /></div>
              <strong>0%</strong>
            </div>
            <span className="progressCount">0 of 6 completed</span>
          </div>

          <div className="setupList" aria-label="Setup checklist">
            {setupSteps.map((step) => step.number === 1 ? (
              <Link className="setupRow" href="/setup/business" key={step.number}>
                <SetupRowContent step={step} />
              </Link>
            ) : (
              <button className="setupRow" type="button" key={step.number} disabled={step.status === "Locked"}>
                <SetupRowContent step={step} />
              </button>
            ))}
          </div>

          <div className="welcomeActions">
            <Link className="primaryButton welcomePrimary" href="/setup/business">
              <span>Start Setup</span><ChevronRightIcon size={18} />
            </Link>
            <button className="secondaryButton" type="button">Explore Dashboard</button>
          </div>
        </div>

        <aside className="welcomeAside">
          <div className="heroVisual">
            <div className="planBanner">
              <span className="successIcon small"><CheckIcon size={18} /></span>
              <div><strong>Core plan activated</strong><span>You now have access to all core features.</span></div>
            </div>
            <div className="handwrittenWelcome">Happier customers.<br />A more efficient you.</div>
            <div className="agentHalo" />
            <div className="agentFigure welcomeAgent">
              <div className="agentHead" />
              <div className="agentBody" />
              <div className="headsetBand" />
              <div className="headsetMic" />
            </div>
            <div className="posterText">Local<br />Businesses<br />Stronger<br />Together</div>
          </div>

          <div className="nextCard">
            <h2>What happens next?</h2>
            <p>In just a few minutes, you&apos;ll be ready to handle customer inquiries and book appointments automatically.</p>

            <div className="nextSteps">
              <div className="nextStep">
                <span className="nextIcon blue"><GearIcon size={24} /></span>
                <div><strong>1. Setup</strong><span>Add your business details, teach your AI and connect your tools.</span></div>
              </div>
              <div className="nextConnector" />
              <div className="nextStep">
                <span className="nextIcon purple"><MessageIcon size={24} /></span>
                <div><strong>2. Test</strong><span>Run a quick test to make sure everything sounds great.</span></div>
              </div>
              <div className="nextConnector" />
              <div className="nextStep">
                <span className="nextIcon green"><RocketIcon size={24} /></span>
                <div><strong>3. Go live</strong><span>Activate your assistant and start helping your customers.</span></div>
              </div>
            </div>

            <div className="resumeNote">
              <span><InfoIcon size={18} /></span>
              <div><strong>You can pause and resume setup anytime.</strong><p>Your progress is saved automatically, so you can take your time.</p></div>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
