import Link from "next/link";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  ChatIcon,
  DatabaseIcon,
  FileIcon,
  HelpIcon,
  LogoMark,
  MessageIcon,
  PhoneIcon,
  SparkleIcon,
  UserIcon,
} from "./icons";

const channels = [
  { label: "Phone", icon: PhoneIcon, className: "channelPhone" },
  { label: "SMS", icon: MessageIcon, className: "channelSms" },
  { label: "WhatsApp", icon: MessageIcon, className: "channelWhatsapp" },
  { label: "Web Chat", icon: ChatIcon, className: "channelWeb" },
];

const flow = [
  { label: "Customer\nInquiry", icon: UserIcon, className: "flowNeutral" },
  { label: "AI\nConversation", icon: SparkleIcon, className: "flowBlue" },
  { label: "Qualified\nLead", icon: FileIcon, className: "flowGreen" },
  { label: "Booked\nAppointment", icon: CalendarIcon, className: "flowPurple" },
];

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="authPage">
      <header className="siteHeader">
        <Link className="brandMini" href="/sign-up" aria-label="AI Caller home">
          <LogoMark size={28} />
          <strong>AI Caller</strong>
        </Link>
        <a className="supportLink" href="mailto:support@aicaller.com">
          <HelpIcon size={18} />
          <span>Need help?</span>
          <strong>Contact support</strong>
        </a>
      </header>

      <section className="authFrame">
        <aside className="brandPanel">
          <div className="brandLarge">
            <LogoMark size={44} />
            <strong>AI Caller</strong>
          </div>

          <h1>Turn customer conversations into booked appointments.</h1>
          <p className="brandCopy">Let AI handle inquiries across phone, text, WhatsApp and web chat—while your team steps in whenever needed.</p>

          <div className="brandMiddle">
            <div className="channelList">
              {channels.map(({ label, icon: Icon, className }) => (
                <div className="channelRow" key={label}>
                  <span className={`channelIcon ${className}`}><Icon size={21} /></span>
                  <span>{label}</span>
                </div>
              ))}
            </div>

            <div className="agentArt" aria-hidden="true">
              <div className="officeNote">Local<br />Businesses<br />Stronger<br />Together</div>
              <div className="agentHalo" />
              <div className="agentFigure">
                <span className="agentHead" />
                <span className="headsetBand" />
                <span className="headsetMic" />
                <span className="agentBody" />
              </div>
              <span className="handNote">More appointments.<br />Happier customers.</span>
            </div>
          </div>

          <div className="flowRow">
            {flow.map(({ label, icon: Icon, className }, index) => (
              <div className="flowGroup" key={label}>
                <div className="flowItem">
                  <span className={`flowIcon ${className}`}><Icon size={25} /></span>
                  <span>{label.split("\n").map((line) => <span key={line}>{line}<br /></span>)}</span>
                </div>
                {index < flow.length - 1 && <span className="flowArrow">→</span>}
              </div>
            ))}
          </div>

          <div className="providerFoot">
            <DatabaseIcon size={21} />
            <span>Powered by your providers or ours.</span>
            <span className="providerPill">BYOP ready</span>
          </div>
        </aside>

        <section className="formPanel">{children}</section>
      </section>
    </main>
  );
}
