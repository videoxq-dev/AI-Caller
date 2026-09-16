"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  FlaskIcon,
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
import "./communication.css";

type Channel = "phone" | "sms" | "whatsapp" | "webchat";
type ProgressState = "complete" | "active" | "locked";
type ProgressStep = {
  number: number;
  title: string;
  description: string;
  tone: "blue" | "purple" | "green" | "orange";
  icon: ReactNode;
  state: ProgressState;
};

const progressSteps: ProgressStep[] = [
  { number: 1, title: "Add your business", description: "Business details, hours and service area", tone: "blue", icon: <StoreIcon size={21} />, state: "complete" },
  { number: 2, title: "Teach your AI", description: "Services, FAQs and policies", tone: "purple", icon: <SparkleIcon size={21} />, state: "complete" },
  { number: 3, title: "Connect communication", description: "Phone, SMS, WhatsApp and web chat", tone: "blue", icon: <PhoneIcon size={20} />, state: "active" },
  { number: 4, title: "Connect your calendar", description: "Google, Outlook, Calendly or Cal.com", tone: "orange", icon: <CalendarIcon size={20} />, state: "locked" },
  { number: 5, title: "Test your AI", description: "Run a chat or call test before going live", tone: "purple", icon: <FlaskIcon size={20} />, state: "locked" },
  { number: 6, title: "Go live", description: "Activate your assistant and start handling inquiries", tone: "blue", icon: <RocketIcon size={20} />, state: "locked" },
];

const phoneNumbers = [
  { number: "+1 (305) 555-0124", location: "Miami, FL" },
  { number: "+1 (305) 555-0187", location: "Miami, FL" },
  { number: "+1 (786) 555-0241", location: "Miami, FL" },
  { number: "+1 (954) 555-0199", location: "Fort Lauderdale, FL" },
];

export default function CommunicationSetupPage() {
  const [channel, setChannel] = useState<Channel>("phone");
  const [providerMode, setProviderMode] = useState<"ours" | "byo">("ours");
  const [numberMode, setNumberMode] = useState<"new" | "existing">("new");
  const [selectedNumber, setSelectedNumber] = useState(phoneNumbers[0].number);

  return (
    <main className="communicationPage">
      <header className="siteHeader communicationHeader">
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

      <div className="communicationGrid">
        <section className="communicationMainCard">
          <div className="communicationIntro">
            <span className="stepBadge">STEP 3 OF 6</span>
            <h1>Connect your communication channels</h1>
            <p>Link the channels your AI assistant will use to talk with your customers.</p>
            <span className="introHelper">You can connect a phone number, SMS, WhatsApp and web chat. Use our providers or connect your own (BYO).</span>
          </div>

          <div className="channelTabs" role="tablist" aria-label="Communication channels">
            <button className={channel === "phone" ? "active" : ""} onClick={() => setChannel("phone")} type="button">
              <span className="channelTabIcon blue"><PhoneIcon size={21} /></span>
              <span><strong>Phone &amp; Voice</strong><small>Make and receive calls</small></span>
            </button>
            <button className={channel === "sms" ? "active" : ""} onClick={() => setChannel("sms")} type="button">
              <span className="channelTabIcon purple"><MessageIcon size={20} /></span>
              <span><strong>SMS</strong><small>Send text messages</small></span>
            </button>
            <button className={channel === "whatsapp" ? "active" : ""} onClick={() => setChannel("whatsapp")} type="button">
              <span className="channelTabIcon green"><MessageIcon size={20} /></span>
              <span><strong>WhatsApp</strong><small>Chat with customers</small></span>
            </button>
            <button className={channel === "webchat" ? "active" : ""} onClick={() => setChannel("webchat")} type="button">
              <span className="channelTabIcon orange"><MessageIcon size={20} /></span>
              <span><strong>Web Chat</strong><small>Add to your website</small></span>
            </button>
          </div>

          {channel === "phone" ? (
            <section className="channelSetupCard">
              <div className="communicationSectionHeading">
                <span className="sectionCircle blue"><PhoneIcon size={23} /></span>
                <div>
                  <h2>Phone &amp; Voice Setup</h2>
                  <p>Connect a phone number so your AI assistant can receive inbound calls.</p>
                </div>
              </div>

              <div className="choiceGrid providerChoiceGrid">
                <button type="button" className={`choiceCard ${providerMode === "ours" ? "selected" : ""}`} onClick={() => setProviderMode("ours")}>
                  <span className="radioDot" />
                  <span className="choiceText"><strong>Use our provider</strong><small>Quick and easy setup with included credits</small></span>
                  <span className="providerBrand oursBrand">AI Caller</span>
                </button>
                <button type="button" className={`choiceCard ${providerMode === "byo" ? "selected" : ""}`} onClick={() => setProviderMode("byo")}>
                  <span className="radioDot" />
                  <span className="choiceText"><strong>Use my own provider (BYO)</strong><small>Connect your existing account</small></span>
                  <span className="providerLogos"><b>telnyx</b><b>plivo</b><b>twilio</b></span>
                </button>
              </div>

              <div className="numberSection">
                <h3>Choose a phone number</h3>
                <p>Get a new number or use an existing number from your connected provider.</p>

                <div className="choiceGrid numberChoiceGrid">
                  <button type="button" className={`choiceCard compact ${numberMode === "new" ? "selected" : ""}`} onClick={() => setNumberMode("new")}>
                    <span className="radioDot" />
                    <span className="choiceText"><strong>Get a new number</strong><small>We&apos;ll find an available number for you</small></span>
                  </button>
                  <button type="button" className={`choiceCard compact ${numberMode === "existing" ? "selected" : ""}`} onClick={() => setNumberMode("existing")}>
                    <span className="radioDot" />
                    <span className="choiceText"><strong>Use existing number</strong><small>Select from your provider account</small></span>
                  </button>
                </div>

                {numberMode === "new" ? (
                  <>
                    <div className="numberSearchGrid">
                      <label className="communicationField">
                        <span>Country</span>
                        <select defaultValue="United States (+1)"><option>United States (+1)</option><option>Canada (+1)</option><option>United Kingdom (+44)</option></select>
                      </label>
                      <label className="communicationField">
                        <span>Area code</span>
                        <input defaultValue="305" inputMode="numeric" />
                      </label>
                      <button type="button" className="searchNumbersButton">Search available numbers</button>
                    </div>

                    <div className="availableNumbers">
                      <h3>Available numbers</h3>
                      <p>Select a number for your business. You can always change this later.</p>
                      <div className="phoneNumberList">
                        {phoneNumbers.map((item) => (
                          <button key={item.number} type="button" className={`phoneNumberRow ${selectedNumber === item.number ? "selected" : ""}`} onClick={() => setSelectedNumber(item.number)}>
                            <span className="radioDot" />
                            <strong>{item.number}</strong>
                            <span className="localTag">Local</span>
                            <span className="locationTag">{item.location}</span>
                            <b>Free</b>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="existingNumberEmpty">
                    <PhoneIcon size={24} />
                    <div><strong>Connect a provider to use an existing number</strong><span>Your numbers will appear here once the provider connection is complete.</span></div>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section className="channelSetupCard alternateChannelCard">
              <div className="communicationSectionHeading">
                <span className={`sectionCircle ${channel === "sms" ? "purple" : channel === "whatsapp" ? "green" : "orange"}`}><MessageIcon size={22} /></span>
                <div>
                  <h2>{channel === "sms" ? "SMS Setup" : channel === "whatsapp" ? "WhatsApp Setup" : "Web Chat Setup"}</h2>
                  <p>{channel === "sms" ? "Connect text messaging so your AI can continue customer conversations by SMS." : channel === "whatsapp" ? "Connect WhatsApp Business so customers can message your AI on WhatsApp." : "Add the AI chat widget to your website so visitors can get help instantly."}</p>
                </div>
              </div>
              <div className="alternateChannelBody">
                <span className={`largeChannelIcon ${channel}`}><MessageIcon size={30} /></span>
                <div><strong>{channel === "webchat" ? "Website chat is included" : "Choose how you want to connect"}</strong><p>{channel === "webchat" ? "We&apos;ll generate a small embed snippet during the final setup step." : "Use AI Caller credits or bring your own provider credentials. Detailed connection controls will appear here."}</p></div>
              </div>
            </section>
          )}

          <div className="communicationFooter">
            <Link className="backLink" href="/setup/ai">←&nbsp;&nbsp;Back to AI setup</Link>
            <div className="formActions">
              <button type="button" className="outlineAction">Save for later</button>
              <Link className="continueAction" href="/setup/calendar">Save &amp; Continue <ChevronRightIcon size={18} /></Link>
            </div>
          </div>
        </section>

        <aside className="communicationSidebar">
          <section className="sidebarCard communicationProgressCard">
            <div className="sidebarProgressTop"><h2>Setup progress</h2><span>Estimated setup time: 7 minutes</span></div>
            <div className="sidebarProgressBar communicationProgressBar"><span /></div>
            <div className="sidebarProgressMeta"><span>2 of 6 completed</span><strong>50%</strong></div>

            <div className="sidebarSteps communicationSteps">
              {progressSteps.map((step) => (
                <div className={`sidebarStep ${step.state}`} key={step.number}>
                  <span className="sidebarStepNumber">{step.number}</span>
                  <span className={`sidebarStepIcon ${step.tone}`}>
                    {step.state === "complete" ? <CheckIcon size={20} /> : step.icon}
                  </span>
                  <div><strong>{step.title}</strong><span>{step.description}</span></div>
                  {step.state === "locked" ? <LockIcon size={15} /> : step.state === "active" ? <ChevronRightIcon size={18} /> : null}
                </div>
              ))}
            </div>
          </section>

          <section className="sidebarCard communicationWhyCard">
            <h2>Why connect communication?</h2>
            <p>Your AI assistant will use these channels to talk with your customers, answer questions, and book appointments — 24/7.</p>

            <div className="communicationBenefits">
              <div className="communicationBenefit"><span className="benefitIcon green"><PhoneIcon size={16} /></span><div><strong>Handle inbound customer calls</strong><small>Never miss a customer inquiry</small></div></div>
              <div className="communicationBenefit"><span className="benefitIcon purple"><MessageIcon size={16} /></span><div><strong>Send and receive text messages</strong><small>Keep customers updated instantly</small></div></div>
              <div className="communicationBenefit"><span className="benefitIcon green"><MessageIcon size={16} /></span><div><strong>Chat with customers on WhatsApp</strong><small>Meet your customers where they are</small></div></div>
              <div className="communicationBenefit"><span className="benefitIcon orange"><MessageIcon size={16} /></span><div><strong>Add web chat to your website</strong><small>Let visitors chat with your AI assistant</small></div></div>
            </div>

            <div className="phoneIllustration" aria-hidden="true">
              <span className="illustrationNote communicationNote">More ways<br />to reach your<br />customers.</span>
              <div className="phoneDevice"><div className="phoneSpeaker" /><LogoMark size={36} /><PhoneIcon size={26} /></div>
              <span className="floatingBadge whatsapp"><MessageIcon size={20} /></span>
              <span className="floatingBadge sms"><MessageIcon size={20} /></span>
            </div>

            <div className="editableNote communicationEditableNote">
              <span className="infoBubble"><InfoIcon size={18} /></span>
              <div><strong>You can add or change channels anytime from Settings.</strong><p>Start with one channel now and connect more later.</p></div>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
