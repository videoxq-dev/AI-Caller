"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckIcon,
  ChevronRightIcon,
  HelpIcon,
  InfoIcon,
  LogoMark,
  MessageIcon,
  PhoneIcon,
} from "@/components/icons";
import { SetupProgressPanel } from "../setup-progress";
import { WebChatSetup, WebChatSidebar } from "./webchat";
import "./communication.css";

type Channel = "phone" | "sms" | "whatsapp" | "webchat";
type Mode = "HOSTED" | "BYOP";
type VoiceProvider = "telnyx" | "plivo" | "twilio";
type SMSProvider = VoiceProvider;
type IntegrationSummary = { provider: string; status: "CONNECTED" | "ERROR" | "DISCONNECTED" };

const phoneNumbers = [
  { number: "+1 (305) 555-0124", location: "Miami, FL" },
  { number: "+1 (305) 555-0187", location: "Miami, FL" },
  { number: "+1 (786) 555-0241", location: "Miami, FL" },
  { number: "+1 (954) 555-0199", location: "Fort Lauderdale, FL" },
];

export default function CommunicationSetupPage() {
  const router = useRouter();
  const [channel, setChannel] = useState<Channel>("phone");
  const [voiceMode, setVoiceMode] = useState<Mode>("HOSTED");
  const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>("telnyx");
  const [numberMode, setNumberMode] = useState<"new" | "existing">("new");
  const [selectedNumber, setSelectedNumber] = useState(phoneNumbers[0].number);
  const [smsMode, setSmsMode] = useState<Mode>("HOSTED");
  const [smsProvider, setSmsProvider] = useState<SMSProvider>("telnyx");
  const [smsNumberMode, setSmsNumberMode] = useState<"same" | "separate">("same");
  const [displayName, setDisplayName] = useState("");
  const [replyWindow, setReplyWindow] = useState("Always respond");
  const [afterHoursBehavior, setAfterHoursBehavior] = useState("Auto-reply + collect details");
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/setup/communication", { cache: "no-store" }).then((response) => response.ok ? response.json() : null),
      fetch("/api/integrations", { cache: "no-store" }).then((response) => response.ok ? response.json() : null),
    ]).then(([setupPayload, integrationPayload]) => {
      const saved = setupPayload?.settings;
      if (saved?.voice) {
        setVoiceMode(saved.voice.mode ?? "HOSTED");
        if (saved.voice.provider) setVoiceProvider(saved.voice.provider);
        setNumberMode(saved.voice.numberMode ?? "new");
        if (saved.voice.number) setSelectedNumber(saved.voice.number);
      }
      if (saved?.sms) {
        setSmsMode(saved.sms.mode ?? "HOSTED");
        if (saved.sms.provider) setSmsProvider(saved.sms.provider);
        setSmsNumberMode(saved.sms.numberMode ?? "same");
        setDisplayName(saved.sms.displayName ?? "");
        setReplyWindow(saved.sms.replyWindow ?? "Always respond");
        setAfterHoursBehavior(saved.sms.afterHoursBehavior ?? "Auto-reply + collect details");
      }
      if (Array.isArray(integrationPayload?.integrations)) setIntegrations(integrationPayload.integrations);
    }).catch(() => undefined);
  }, []);

  const connected = useMemo(() => new Set(integrations.filter((item) => item.status === "CONNECTED").map((item) => item.provider)), [integrations]);
  const whatsappConnected = connected.has("whatsapp");

  async function save(completeStep: boolean) {
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/setup/communication", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          voice: { mode: voiceMode, provider: voiceMode === "BYOP" ? voiceProvider : null, numberMode, number: selectedNumber },
          sms: { mode: smsMode, provider: smsMode === "BYOP" ? smsProvider : null, numberMode: smsNumberMode, displayName, replyWindow, afterHoursBehavior },
          whatsapp: { mode: "BYOP", provider: "whatsapp", accountMode: "existing" },
          webchat: { enabled: true },
          completeStep,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to save communication settings.");
      if (completeStep) router.push("/setup/calendar");
      else setNotice("Communication settings saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to save communication settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="communicationPage">
      <header className="siteHeader communicationHeader">
        <Link className="brandMini" href="/welcome" aria-label="AI Caller home"><LogoMark size={35} /><strong>AI Caller</strong></Link>
        <a className="supportLink" href="mailto:support@aicaller.com"><HelpIcon size={17} /><span>Need help?</span><strong>Contact support</strong></a>
      </header>

      <div className="communicationGrid">
        <section className="communicationMainCard">
          <div className="communicationIntro">
            <span className="stepBadge">STEP 3 OF 6</span>
            <h1>Connect your communication channels</h1>
            <p>Link the channels your AI assistant will use to talk with your customers.</p>
            <span className="introHelper">Hosted voice and SMS use AI Caller credits. BYOP providers and your Meta WhatsApp connection are shared with Integrations.</span>
          </div>

          <div className="channelTabs" role="tablist" aria-label="Communication channels">
            <button className={channel === "phone" ? "active" : ""} onClick={() => setChannel("phone")} type="button"><span className="channelTabIcon blue"><PhoneIcon size={21} /></span><span><strong>Phone &amp; Voice</strong><small>Receive inbound calls</small></span></button>
            <button className={channel === "sms" ? "active" : ""} onClick={() => setChannel("sms")} type="button"><span className="channelTabIcon purple"><MessageIcon size={20} /></span><span><strong>SMS</strong><small>Send text messages</small></span></button>
            <button className={channel === "whatsapp" ? "active" : ""} onClick={() => setChannel("whatsapp")} type="button"><span className="channelTabIcon green"><MessageIcon size={20} /></span><span><strong>WhatsApp</strong><small>Connect with Meta</small></span></button>
            <button className={channel === "webchat" ? "active" : ""} onClick={() => setChannel("webchat")} type="button"><span className="channelTabIcon orange"><MessageIcon size={20} /></span><span><strong>Web Chat</strong><small>Add to your website</small></span></button>
          </div>

          {channel === "phone" && (
            <section className="channelSetupCard">
              <div className="communicationSectionHeading"><span className="sectionCircle blue"><PhoneIcon size={23} /></span><div><h2>Phone &amp; Voice Setup</h2><p>Choose how inbound voice will be routed.</p></div></div>
              <div className="choiceGrid providerChoiceGrid">
                <button type="button" className={`choiceCard ${voiceMode === "HOSTED" ? "selected" : ""}`} onClick={() => setVoiceMode("HOSTED")}><span className="radioDot" /><span className="choiceText"><strong>Use our provider</strong><small>Hosted usage is charged against your credits</small></span><span className="providerBrand oursBrand">AI Caller</span></button>
                <button type="button" className={`choiceCard ${voiceMode === "BYOP" ? "selected" : ""}`} onClick={() => setVoiceMode("BYOP")}><span className="radioDot" /><span className="choiceText"><strong>Use my own provider (BYOP)</strong><small>Use your own Telnyx, Plivo or Twilio account</small></span><span className="providerLogos"><b>telnyx</b><b>plivo</b><b>twilio</b></span></button>
              </div>
              {voiceMode === "BYOP" && <ProviderChooser label="Voice provider" value={voiceProvider} onChange={(value) => setVoiceProvider(value as VoiceProvider)} connected={connected.has(voiceProvider)} />}

              <div className="numberSection">
                <h3>Choose a phone number</h3><p>Get a hosted number or use one from your connected BYOP account.</p>
                <div className="choiceGrid numberChoiceGrid">
                  <button type="button" className={`choiceCard compact ${numberMode === "new" ? "selected" : ""}`} onClick={() => setNumberMode("new")}><span className="radioDot" /><span className="choiceText"><strong>Get a new number</strong><small>Choose an available hosted number</small></span></button>
                  <button type="button" className={`choiceCard compact ${numberMode === "existing" ? "selected" : ""}`} onClick={() => setNumberMode("existing")}><span className="radioDot" /><span className="choiceText"><strong>Use existing number</strong><small>Use a number from your provider account</small></span></button>
                </div>
                {numberMode === "new" ? <div className="availableNumbers"><h3>Available numbers</h3><div className="phoneNumberList">{phoneNumbers.map((item) => <button key={item.number} type="button" className={`phoneNumberRow ${selectedNumber === item.number ? "selected" : ""}`} onClick={() => setSelectedNumber(item.number)}><span className="radioDot" /><strong>{item.number}</strong><span className="localTag">Local</span><span className="locationTag">{item.location}</span><b>Free</b></button>)}</div></div> : <div className="existingNumberEmpty"><PhoneIcon size={24} /><div><strong>{voiceMode === "BYOP" && connected.has(voiceProvider) ? "Your connected provider will supply the number" : "Connect your provider first"}</strong><span>Provider numbers will be synchronized when live channel transport is enabled.</span></div></div>}
              </div>
            </section>
          )}

          {channel === "sms" && (
            <section className="channelSetupCard smsSetupCard">
              <div className="communicationSectionHeading"><span className="sectionCircle purple"><MessageIcon size={23} /></span><div><h2>SMS Setup</h2><p>Choose the provider and messaging behavior for text conversations.</p></div></div>
              <div className="choiceGrid providerChoiceGrid">
                <button type="button" className={`choiceCard ${smsMode === "HOSTED" ? "selected" : ""}`} onClick={() => setSmsMode("HOSTED")}><span className="radioDot" /><span className="choiceText"><strong>Use our provider</strong><small>Hosted SMS uses your AI Caller credits</small></span><span className="providerBrand smsAiCaller"><LogoMark size={25} /> AI Caller</span></button>
                <button type="button" className={`choiceCard ${smsMode === "BYOP" ? "selected" : ""}`} onClick={() => setSmsMode("BYOP")}><span className="radioDot" /><span className="choiceText"><strong>Use my own provider (BYOP)</strong><small>Use your existing messaging provider</small></span><span className="providerLogos"><b>telnyx</b><b>plivo</b><b>twilio</b></span></button>
              </div>
              {smsMode === "BYOP" && <ProviderChooser label="SMS provider" value={smsProvider} onChange={(value) => setSmsProvider(value as SMSProvider)} connected={connected.has(smsProvider)} />}
              <div className="smsBlock"><h3>Choose an SMS number</h3><div className="choiceGrid numberChoiceGrid"><button type="button" className={`choiceCard compact ${smsNumberMode === "same" ? "selected" : ""}`} onClick={() => setSmsNumberMode("same")}><span className="radioDot" /><span className="choiceText"><strong>Use the same business number</strong><small>{selectedNumber}</small></span></button><button type="button" className={`choiceCard compact ${smsNumberMode === "separate" ? "selected" : ""}`} onClick={() => setSmsNumberMode("separate")}><span className="radioDot" /><span className="choiceText"><strong>Use a separate SMS number</strong><small>Choose a dedicated text number later</small></span></button></div></div>
              <div className="smsBlock messagingSettingsBlock"><h3>Messaging settings</h3><div className="smsSettingsGrid"><label className="communicationField"><span>Display business name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your business name" /></label><label className="communicationField"><span>Reply window</span><select value={replyWindow} onChange={(event) => setReplyWindow(event.target.value)}><option>Always respond</option><option>Business hours only</option><option>After-hours only</option></select></label><label className="communicationField"><span>After-hours behavior</span><select value={afterHoursBehavior} onChange={(event) => setAfterHoursBehavior(event.target.value)}><option>Auto-reply + collect details</option><option>Auto-reply only</option><option>Hold for next business day</option></select></label><div className="complianceField"><span className="complianceLabel">Compliance</span><div className="compliancePills"><span><CheckIcon size={13} /> STOP / HELP enabled</span><span><CheckIcon size={13} /> Consent reminder included</span></div></div></div></div>
            </section>
          )}

          {channel === "whatsapp" && (
            <section className="channelSetupCard whatsappSetupCard">
              <div className="communicationSectionHeading"><span className="sectionCircle green"><MessageIcon size={23} /></span><div><h2>WhatsApp Setup</h2><p>Connect your business directly through AI Caller&apos;s approved Meta Tech Provider app.</p></div></div>
              <div className="whatsappBlock">
                <h3>Meta Embedded Signup</h3>
                <div className="existingNumberEmpty"><MessageIcon size={24} /><div><strong>{whatsappConnected ? "WhatsApp Business is connected" : "Connect WhatsApp with Meta"}</strong><span>{whatsappConnected ? "Your Meta business assets are authorized and ready for this workspace." : "Sign in with Meta to select or create your business portfolio, WhatsApp Business Account and phone number. No API keys need to be copied into AI Caller."}</span></div><Link className="outlineAction" href="/integrations?provider=whatsapp&return=%2Fsetup%2Fcommunication">{whatsappConnected ? "Manage" : "Connect with Meta"}</Link></div>
              </div>
              <div className="whatsappBlock">
                <h3>How the connection works</h3>
                <div className="compliancePills"><span><CheckIcon size={13} /> Official Meta Cloud API</span><span><CheckIcon size={13} /> Customer-owned WhatsApp assets</span><span><CheckIcon size={13} /> Access token encrypted server-side</span><span><CheckIcon size={13} /> Webhook subscription handled automatically</span></div>
              </div>
            </section>
          )}

          {channel === "webchat" && <WebChatSetup />}

          {notice && <div className="editableNote communicationEditableNote"><span className="infoBubble"><InfoIcon size={18} /></span><div><strong>{notice}</strong></div></div>}
          <div className="communicationFooter"><Link className="backLink" href="/setup/ai">←&nbsp;&nbsp;Back to AI setup</Link><div className="formActions"><button type="button" className="outlineAction" disabled={saving} onClick={() => save(false)}>{saving ? "Saving..." : "Save for later"}</button><button type="button" className="continueAction" disabled={saving} onClick={() => save(true)}>Save &amp; Continue <ChevronRightIcon size={18} /></button></div></div>
        </section>

        <aside className="communicationSidebar">
          <SetupProgressPanel currentStep={3} estimated="7 minutes" className="sidebarCard communicationProgressCard" progressClassName="sidebarProgressBar communicationProgressBar" />
          {channel === "webchat" ? <WebChatSidebar /> : <section className="sidebarCard communicationWhyCard"><h2>One setup, one routing layer</h2><p>Voice and SMS can use hosted or BYOP routing. WhatsApp connects directly through Meta Embedded Signup and is stored as the workspace&apos;s WhatsApp capability.</p><div className="communicationBenefits"><div className="communicationBenefit"><span className="benefitIcon green"><CheckIcon size={16} /></span><div><strong>Provider-independent</strong><small>Switch voice or SMS providers without changing conversation logic.</small></div></div><div className="communicationBenefit"><span className="benefitIcon blue"><PhoneIcon size={16} /></span><div><strong>Inbound voice only</strong><small>Voice setup remains aligned with the MVP boundary.</small></div></div></div></section>}
        </aside>
      </div>
    </main>
  );
}

function ProviderChooser({ label, value, onChange, connected }: { label: string; value: string; onChange: (value: string) => void; connected: boolean }) {
  return <div className="existingNumberEmpty"><PhoneIcon size={22} /><div><strong>{label}</strong><select className="communicationField" value={value} onChange={(event) => onChange(event.target.value)}><option value="telnyx">Telnyx</option><option value="plivo">Plivo</option><option value="twilio">Twilio</option></select><span>{connected ? "Connected and ready to use." : "Credentials are not connected yet."}</span></div><Link className="outlineAction" href={`/integrations?provider=${value}&return=%2Fsetup%2Fcommunication`}>{connected ? "Manage" : "Connect"}</Link></div>;
}
