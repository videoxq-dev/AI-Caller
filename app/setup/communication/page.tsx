"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
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
  UsersIcon,
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
  const [smsProviderMode, setSmsProviderMode] = useState<"ours" | "byo">("ours");
  const [smsNumberMode, setSmsNumberMode] = useState<"same" | "separate">("same");
  const [whatsappProviderMode, setWhatsappProviderMode] = useState<"ours" | "byo">("ours");
  const [whatsappAccountMode, setWhatsappAccountMode] = useState<"new" | "existing">("new");

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

          {channel === "phone" && (
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
          )}

          {channel === "sms" && (
            <section className="channelSetupCard smsSetupCard">
              <div className="communicationSectionHeading">
                <span className="sectionCircle purple"><MessageIcon size={23} /></span>
                <div>
                  <h2>SMS Setup</h2>
                  <p>Connect text messaging so your AI assistant can continue customer conversations by SMS.</p>
                </div>
              </div>

              <div className="choiceGrid providerChoiceGrid">
                <button type="button" className={`choiceCard ${smsProviderMode === "ours" ? "selected" : ""}`} onClick={() => setSmsProviderMode("ours")}>
                  <span className="radioDot" />
                  <span className="choiceText"><strong>Use our provider</strong><small>Fastest setup with included credits</small></span>
                  <span className="providerBrand smsAiCaller"><LogoMark size={25} /> AI Caller</span>
                </button>
                <button type="button" className={`choiceCard ${smsProviderMode === "byo" ? "selected" : ""}`} onClick={() => setSmsProviderMode("byo")}>
                  <span className="radioDot" />
                  <span className="choiceText"><strong>Use my own provider (BYO)</strong><small>Connect your existing messaging provider</small></span>
                  <span className="providerLogos"><b>telnyx</b><b>plivo</b><b>twilio</b></span>
                </button>
              </div>

              <div className="smsBlock">
                <h3>Choose an SMS number</h3>
                <p>Use the same number as voice setup or connect a dedicated text number.</p>
                <div className="choiceGrid numberChoiceGrid">
                  <button type="button" className={`choiceCard compact ${smsNumberMode === "same" ? "selected" : ""}`} onClick={() => setSmsNumberMode("same")}>
                    <span className="radioDot" />
                    <span className="choiceText"><strong>Use the same business number</strong><small>+1 (305) 555-0124</small></span>
                  </button>
                  <button type="button" className={`choiceCard compact ${smsNumberMode === "separate" ? "selected" : ""}`} onClick={() => setSmsNumberMode("separate")}>
                    <span className="radioDot" />
                    <span className="choiceText"><strong>Use a separate SMS number</strong><small>Choose a different number for messaging</small></span>
                  </button>
                </div>
              </div>

              <div className="smsBlock messagingSettingsBlock">
                <h3>Messaging settings</h3>
                <div className="smsSettingsGrid">
                  <label className="communicationField"><span>Display business name</span><input defaultValue="Brightside Auto Spa" /></label>
                  <label className="communicationField"><span>Reply window</span><select defaultValue="Always respond"><option>Always respond</option><option>Business hours only</option><option>After-hours only</option></select></label>
                  <label className="communicationField"><span>After-hours behavior</span><select defaultValue="Auto-reply + collect details"><option>Auto-reply + collect details</option><option>Auto-reply only</option><option>Hold for next business day</option></select></label>
                  <div className="complianceField"><span className="complianceLabel">Compliance</span><div className="compliancePills"><span><CheckIcon size={13} /> STOP / HELP keywords enabled</span><span><CheckIcon size={13} /> Consent reminder included</span></div></div>
                </div>
              </div>

              <div className="smsBlock previewBlock">
                <h3>Conversation preview</h3>
                <div className="conversationPreview">
                  <div className="previewMessage customerMessage"><span className="previewAvatar customerAvatar">●</span><div><p>Hi, do you have any openings tomorrow for a full detailing?</p><small>10:14 AM</small></div></div>
                  <div className="previewMessage aiMessage"><span className="previewAvatar aiAvatar"><LogoMark size={21} /></span><div><p>Yes — we have a few openings tomorrow. I can help you book one. What time works best for you?</p><small>10:14 AM</small></div></div>
                  <div className="previewMessage customerMessage"><span className="previewAvatar customerAvatar">●</span><div><p>Around 2pm if possible.</p><small>10:16 AM</small></div></div>
                  <div className="previewMessage aiMessage"><span className="previewAvatar aiAvatar"><LogoMark size={21} /></span><div><p>We have 2:30 PM available. Would you like me to reserve it for you?</p><small>10:16 AM</small></div></div>
                </div>
                <p className="previewCaption">Your AI will reply instantly, answer questions, and guide customers toward booking.</p>
              </div>
            </section>
          )}

          {channel === "whatsapp" && (
            <section className="channelSetupCard whatsappSetupCard">
              <div className="communicationSectionHeading">
                <span className="sectionCircle green"><MessageIcon size={23} /></span>
                <div><h2>WhatsApp Setup</h2><p>Connect WhatsApp so your AI assistant can chat with your customers on the world&apos;s most popular messaging app.</p></div>
              </div>

              <div className="whatsappBlock">
                <h3>Choose how to connect</h3>
                <div className="choiceGrid providerChoiceGrid whatsappProviderGrid">
                  <button type="button" className={`choiceCard whatsappChoiceCard ${whatsappProviderMode === "ours" ? "selected" : ""}`} onClick={() => setWhatsappProviderMode("ours")}>
                    <span className="radioDot" />
                    <span className="choiceText"><strong>Use our provider (recommended)</strong><small>Quick and easy setup with a verified WhatsApp Business account.</small><em className="officialApiTag">Official WhatsApp Business API</em></span>
                    <span className="providerBrand metaBrand">∞ Meta</span>
                  </button>
                  <button type="button" className={`choiceCard whatsappChoiceCard ${whatsappProviderMode === "byo" ? "selected" : ""}`} onClick={() => setWhatsappProviderMode("byo")}>
                    <span className="radioDot" />
                    <span className="choiceText"><strong>Use my own provider (BYO)</strong><small>Connect your existing WhatsApp Business API account.</small><span className="whatsappProviderLogos"><b>twilio</b><b>360dialog</b><b>MessageBird</b></span></span>
                  </button>
                </div>
              </div>

              <div className="whatsappBlock">
                <h3>Connect a WhatsApp Business account</h3>
                <p>Link your existing WhatsApp Business account or create a new one.</p>
                <div className="choiceGrid numberChoiceGrid">
                  <button type="button" className={`choiceCard compact ${whatsappAccountMode === "new" ? "selected" : ""}`} onClick={() => setWhatsappAccountMode("new")}>
                    <span className="radioDot" />
                    <span className="choiceText"><strong>Create a new business account</strong><small>We&apos;ll guide you through the WhatsApp Business setup and verification.</small></span>
                  </button>
                  <button type="button" className={`choiceCard compact ${whatsappAccountMode === "existing" ? "selected" : ""}`} onClick={() => setWhatsappAccountMode("existing")}>
                    <span className="radioDot" />
                    <span className="choiceText"><strong>Connect existing account</strong><small>Use an existing WhatsApp Business account.</small></span>
                  </button>
                </div>
              </div>

              <div className="whatsappBlock whatsappBusinessInfo">
                <h3>Business information</h3>
                <p>This information will be used for WhatsApp Business verification.</p>
                <div className="whatsappInfoGrid">
                  <label className="communicationField"><span>Business name</span><input defaultValue="Brightside Auto Spa" /><small className="fieldCounter">18/100</small></label>
                  <label className="communicationField"><span>Business category</span><select defaultValue="Automotive Service"><option>Automotive Service</option><option>Professional Services</option><option>Retail</option><option>Health &amp; Beauty</option></select></label>
                  <label className="communicationField"><span>Website (optional)</span><input type="url" defaultValue="https://www.brightsideautospa.com" /></label>
                  <label className="communicationField"><span>Business description</span><textarea rows={2} defaultValue="Professional car detailing, washing and ceramic coating services in Miami." /><small className="fieldCounter">72/512</small></label>
                </div>
              </div>

              <div className="whatsappBlock whatsappMessagingSettings">
                <div className="whatsappSettingsHeader"><span className="settingsIcon">⚙</span><div><h3>Messaging settings</h3><p>Control how your AI assistant responds on WhatsApp.</p></div></div>
                <div className="whatsappSettingsGrid">
                  <label className="communicationField"><span>Reply window</span><select defaultValue="24 hours (recommended)"><option>24 hours (recommended)</option><option>Business hours only</option><option>Always respond</option></select><small>WhatsApp allows business-initiated messages within 24 hours of a customer&apos;s last message.</small></label>
                  <label className="communicationField"><span>After-hours behavior</span><select defaultValue="Use AI assistant (recommended)"><option>Use AI assistant (recommended)</option><option>Send away message</option><option>Pause replies</option></select><small>Your AI assistant will continue to respond even outside business hours.</small></label>
                  <label className="communicationField"><span>Welcome message (optional)</span><textarea rows={3} defaultValue="Hi! 👋 Welcome to Brightside Auto Spa. How can we help you today?" /><small className="fieldCounter">57/250</small></label>
                </div>
              </div>
            </section>
          )}

          {channel === "webchat" && (
            <section className="channelSetupCard alternateChannelCard">
              <div className="communicationSectionHeading"><span className="sectionCircle orange"><MessageIcon size={22} /></span><div><h2>Web Chat Setup</h2><p>Add the AI chat widget to your website so visitors can get help instantly.</p></div></div>
              <div className="alternateChannelBody"><span className="largeChannelIcon webchat"><MessageIcon size={30} /></span><div><strong>Website chat is included</strong><p>We&apos;ll generate a small embed snippet during the final setup step.</p></div></div>
            </section>
          )}

          <div className="communicationFooter">
            <Link className="backLink" href="/setup/ai">←&nbsp;&nbsp;Back to AI setup</Link>
            <div className="formActions"><button type="button" className="outlineAction">Save for later</button><Link className="continueAction" href="/setup/calendar">Save &amp; Continue <ChevronRightIcon size={18} /></Link></div>
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
                  <span className={`sidebarStepIcon ${step.tone}`}>{step.state === "complete" ? <CheckIcon size={20} /> : step.icon}</span>
                  <div><strong>{step.title}</strong><span>{step.description}</span></div>
                  {step.state === "locked" ? <LockIcon size={15} /> : step.state === "active" ? <ChevronRightIcon size={18} /> : null}
                </div>
              ))}
            </div>
          </section>

          {channel === "sms" ? (
            <section className="sidebarCard communicationWhyCard smsWhyCard">
              <h2>Why connect SMS?</h2>
              <p>SMS helps your AI respond instantly, continue conversations after missed calls, confirm appointments, and keep customers updated.</p>
              <div className="communicationBenefits smsBenefits">
                <div className="communicationBenefit"><span className="benefitIcon green"><SparkleIcon size={16} /></span><div><strong>Respond to customer questions instantly</strong><small>Fast, familiar communication</small></div></div>
                <div className="communicationBenefit"><span className="benefitIcon purple"><PhoneIcon size={16} /></span><div><strong>Recover missed calls with automatic text-back</strong><small>Don&apos;t lose inbound leads</small></div></div>
                <div className="communicationBenefit"><span className="benefitIcon orange"><CalendarIcon size={16} /></span><div><strong>Send confirmations and reminders</strong><small>Reduce no-shows</small></div></div>
                <div className="communicationBenefit"><span className="benefitIcon blue"><ClockIcon size={16} /></span><div><strong>Keep the conversation going after hours</strong><small>Capture leads 24/7</small></div></div>
              </div>
              <div className="phoneIllustration smsPhoneIllustration" aria-hidden="true"><span className="illustrationNote communicationNote">Fast replies.<br />More bookings.</span><div className="phoneDevice smsPhoneDevice"><div className="phoneSpeaker" /><span className="smsPreviewBubble top" /><span className="smsPreviewBubble bottom" /></div></div>
              <div className="editableNote communicationEditableNote"><span className="infoBubble"><InfoIcon size={18} /></span><div><strong>You can add or change channels anytime from Settings.</strong><p>Start with SMS now and connect more later.</p></div></div>
            </section>
          ) : channel === "whatsapp" ? (
            <section className="sidebarCard communicationWhyCard whatsappWhyCard">
              <h2>Why connect WhatsApp?</h2>
              <p>Your customers are already on WhatsApp. Let them chat with your AI assistant, get answers, book appointments and more — all from the app they trust.</p>
              <div className="communicationBenefits whatsappBenefits">
                <div className="communicationBenefit"><span className="benefitIcon green"><SparkleIcon size={16} /></span><div><strong>Reach more customers</strong><small>Chat with millions of WhatsApp users</small></div></div>
                <div className="communicationBenefit"><span className="benefitIcon purple"><ClockIcon size={16} /></span><div><strong>Automate responses</strong><small>Answer common questions 24/7</small></div></div>
                <div className="communicationBenefit"><span className="benefitIcon blue"><CalendarIcon size={16} /></span><div><strong>Book appointments</strong><small>Let customers book directly in chat</small></div></div>
                <div className="communicationBenefit"><span className="benefitIcon orange"><UsersIcon size={16} /></span><div><strong>Build lasting relationships</strong><small>Provide fast, convenient support</small></div></div>
              </div>
              <div className="whatsappPhoneIllustration" aria-hidden="true">
                <span className="illustrationNote whatsappNote">Meet your<br />customers where<br />they are.</span>
                <div className="whatsappPhone"><div className="phoneSpeaker" /><span className="whatsappLogoBubble"><MessageIcon size={23} /></span><span className="waBubble incoming">Hi! Do you offer<br />ceramic coating?</span><span className="waBubble outgoing">Yes! Would you<br />like to book an appointment?</span></div>
              </div>
              <div className="editableNote communicationEditableNote"><span className="infoBubble"><InfoIcon size={18} /></span><div><strong>You can change these settings anytime from Settings.</strong><p>Add or disconnect channels, update your business information, or configure advanced options at any time.</p></div></div>
            </section>
          ) : (
            <section className="sidebarCard communicationWhyCard">
              <h2>Why connect communication?</h2>
              <p>Your AI assistant will use these channels to talk with your customers, answer questions, and book appointments — 24/7.</p>
              <div className="communicationBenefits">
                <div className="communicationBenefit"><span className="benefitIcon green"><PhoneIcon size={16} /></span><div><strong>Handle inbound customer calls</strong><small>Never miss a customer inquiry</small></div></div>
                <div className="communicationBenefit"><span className="benefitIcon purple"><MessageIcon size={16} /></span><div><strong>Send and receive text messages</strong><small>Keep customers updated instantly</small></div></div>
                <div className="communicationBenefit"><span className="benefitIcon green"><MessageIcon size={16} /></span><div><strong>Chat with customers on WhatsApp</strong><small>Meet your customers where they are</small></div></div>
                <div className="communicationBenefit"><span className="benefitIcon orange"><MessageIcon size={16} /></span><div><strong>Add web chat to your website</strong><small>Let visitors chat with your AI assistant</small></div></div>
              </div>
              <div className="phoneIllustration" aria-hidden="true"><span className="illustrationNote communicationNote">More ways<br />to reach your<br />customers.</span><div className="phoneDevice"><div className="phoneSpeaker" /><LogoMark size={36} /><PhoneIcon size={26} /></div><span className="floatingBadge whatsapp"><MessageIcon size={20} /></span><span className="floatingBadge sms"><MessageIcon size={20} /></span></div>
              <div className="editableNote communicationEditableNote"><span className="infoBubble"><InfoIcon size={18} /></span><div><strong>You can add or change channels anytime from Settings.</strong><p>Start with one channel now and connect more later.</p></div></div>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
