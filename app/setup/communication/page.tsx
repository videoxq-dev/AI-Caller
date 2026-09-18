"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckIcon,
  ChevronRightIcon,
  HelpIcon,
  LogoMark,
  MessageIcon,
  PhoneIcon,
} from "@/components/icons";
import { showToast } from "@/components/toast";
import { SetupProgressPanel } from "../setup-progress";
import { WebChatSetup, WebChatSidebar } from "./webchat";
import "./communication.css";

type Channel = "phone" | "sms" | "whatsapp" | "webchat";
type IntegrationSummary = { provider: string; status: "CONNECTED" | "ERROR" | "DISCONNECTED" };
type VoiceConfig = {
  configured: boolean;
  receiverNumber: string | null;
};

function responseError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return fallback;
  const value = error as { message?: unknown; details?: unknown };
  const details = value.details;
  if (details && typeof details === "object") {
    const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
    if (fieldErrors && typeof fieldErrors === "object") {
      for (const messages of Object.values(fieldErrors as Record<string, unknown>)) {
        if (Array.isArray(messages)) {
          const first = messages.find((message): message is string => typeof message === "string" && Boolean(message.trim()));
          if (first) return first;
        }
      }
    }
    const formErrors = (details as { formErrors?: unknown }).formErrors;
    if (Array.isArray(formErrors)) {
      const first = formErrors.find((message): message is string => typeof message === "string" && Boolean(message.trim()));
      if (first) return first;
    }
  }
  return typeof value.message === "string" && value.message !== "The request contains invalid data."
    ? value.message
    : fallback;
}

export default function CommunicationSetupPage() {
  const router = useRouter();
  const [channel, setChannel] = useState<Channel>("phone");
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>({ configured: false, receiverNumber: null });
  const [displayName, setDisplayName] = useState("");
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/setup/communication", { cache: "no-store" }).then((response) => response.ok ? response.json() : null),
      fetch("/api/integrations", { cache: "no-store" }).then((response) => response.ok ? response.json() : null),
      fetch("/api/integrations/voice/config", { cache: "no-store" }).then((response) => response.ok ? response.json() : null),
    ]).then(([setupPayload, integrationPayload, voicePayload]) => {
      if (voicePayload) {
        setVoiceConfig({
          configured: voicePayload.configured === true,
          receiverNumber: typeof voicePayload.receiverNumber === "string" ? voicePayload.receiverNumber : null,
        });
      }
      if (typeof setupPayload?.settings?.sms?.displayName === "string") {
        setDisplayName(setupPayload.settings.sms.displayName);
      }
      if (Array.isArray(integrationPayload?.integrations)) setIntegrations(integrationPayload.integrations);
    }).catch(() => showToast("Some communication settings could not be loaded. You can still continue setup.", "error"));
  }, []);

  const connected = useMemo(
    () => new Set(integrations.filter((item) => item.status === "CONNECTED").map((item) => item.provider)),
    [integrations],
  );
  const whatsappConnected = connected.has("whatsapp");

  async function save(completeStep: boolean) {
    setSaving(true);
    try {
      const response = await fetch("/api/setup/communication", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // Voice still uses the existing inbound adapter internally. Provider details stay out of onboarding.
          voice: { mode: "BYOP", provider: "telnyx", numberMode: "existing", number: voiceConfig.receiverNumber },
          sms: {
            mode: "HOSTED",
            provider: null,
            numberMode: "same",
            number: null,
            displayName,
            replyWindow: "Always respond",
            afterHoursBehavior: "Auto-reply + collect details",
          },
          // Embedded Signup authorizes customer-owned WhatsApp assets through the platform app.
          whatsapp: { mode: "BYOP", provider: "whatsapp", accountMode: "existing" },
          webchat: { enabled: true },
          completeStep,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(responseError(payload, "We could not save your communication setup. Check the highlighted channel and try again."));
      }
      if (completeStep) {
        showToast("Communication setup saved. You can finish optional channel connections later.", "success");
        router.push("/setup/calendar");
      } else {
        showToast("Communication settings saved.", "success");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to save communication settings.", "error");
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
            <p>Choose how customers can reach your AI assistant. Phone and messaging connections can be finished later.</p>
          </div>

          <div className="channelTabs" role="tablist" aria-label="Communication channels">
            <button className={channel === "phone" ? "active" : ""} onClick={() => setChannel("phone")} type="button"><span className="channelTabIcon blue"><PhoneIcon size={21} /></span><span><strong>Phone &amp; Voice</strong><small>Receive inbound calls</small></span></button>
            <button className={channel === "sms" ? "active" : ""} onClick={() => setChannel("sms")} type="button"><span className="channelTabIcon purple"><MessageIcon size={20} /></span><span><strong>SMS</strong><small>Send text messages</small></span></button>
            <button className={channel === "whatsapp" ? "active" : ""} onClick={() => setChannel("whatsapp")} type="button"><span className="channelTabIcon green"><MessageIcon size={20} /></span><span><strong>WhatsApp</strong><small>Connect your account</small></span></button>
            <button className={channel === "webchat" ? "active" : ""} onClick={() => setChannel("webchat")} type="button"><span className="channelTabIcon orange"><MessageIcon size={20} /></span><span><strong>Web Chat</strong><small>Add to your website</small></span></button>
          </div>

          {channel === "phone" && (
            <section className="channelSetupCard">
              <div className="communicationSectionHeading"><span className="sectionCircle blue"><PhoneIcon size={23} /></span><div><h2>Phone &amp; Voice Setup</h2><p>Configure the number customers call to reach your AI assistant. Outbound AI calling is not enabled.</p></div></div>
              <div className="existingNumberEmpty voiceConnectionSummary">
                <PhoneIcon size={24} />
                <div>
                  <strong>{voiceConfig.receiverNumber ?? "Configure your phone number"}</strong>
                  <span>{voiceConfig.configured ? "Your inbound phone connection is ready." : "Phone activation is optional during onboarding. You can finish it before going live."}</span>
                </div>
                <Link className="outlineAction noWrapAction" href="/integrations?provider=telnyx&return=%2Fsetup%2Fcommunication">{voiceConfig.configured ? "Manage number" : "Connect Phone number"}</Link>
              </div>
            </section>
          )}

          {channel === "sms" && (
            <section className="channelSetupCard smsSetupCard">
              <div className="communicationSectionHeading"><span className="sectionCircle purple"><MessageIcon size={23} /></span><div><h2>SMS Setup</h2><p>SMS is hosted by AI Caller and billed from your hosted credits. There is no provider setup during onboarding.</p></div></div>
              <div className="smsBlock">
                <h3>SMS number</h3>
                <div className="existingNumberEmpty">
                  <PhoneIcon size={24} />
                  <div><strong>{voiceConfig.receiverNumber ?? "Phone number not configured yet"}</strong><span>{voiceConfig.receiverNumber ? "SMS will use your configured business number." : "You can continue now and assign the hosted messaging number before going live."}</span></div>
                </div>
              </div>
              <div className="smsBlock messagingSettingsBlock">
                <h3>Messaging identity</h3>
                <div className="smsSettingsGrid">
                  <label className="communicationField"><span>Display business name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={100} placeholder="Your business name" /></label>
                  <div className="complianceField"><span className="complianceLabel">Messaging safeguards</span><div className="compliancePills"><span><CheckIcon size={13} /> STOP / HELP handling enabled</span><span><CheckIcon size={13} /> Hosted routing managed by AI Caller</span></div></div>
                </div>
              </div>
            </section>
          )}

          {channel === "whatsapp" && (
            <section className="channelSetupCard whatsappSetupCard">
              <div className="communicationSectionHeading"><span className="sectionCircle green"><MessageIcon size={23} /></span><div><h2>WhatsApp Setup</h2><p>Connect your WhatsApp Business assets through the secure embedded signup flow.</p></div></div>
              <div className="whatsappBlock">
                <h3>WhatsApp Business</h3>
                <div className="existingNumberEmpty"><MessageIcon size={24} /><div><strong>{whatsappConnected ? "WhatsApp Business is connected" : "Connect WhatsApp"}</strong><span>{whatsappConnected ? "Your business assets are authorized and ready for this workspace." : "Sign in to select or create your business portfolio, WhatsApp Business Account and phone number. No API keys need to be copied into AI Caller."}</span></div><Link className="outlineAction noWrapAction" href="/integrations?provider=whatsapp&return=%2Fsetup%2Fcommunication">{whatsappConnected ? "Manage" : "Connect with Meta"}</Link></div>
              </div>
            </section>
          )}

          {channel === "webchat" && <WebChatSetup />}

          <div className="communicationFooter"><Link className="backLink" href="/setup/ai">←&nbsp;&nbsp;Back to AI setup</Link><div className="formActions"><button type="button" className="outlineAction" disabled={saving} onClick={() => save(false)}>{saving ? "Saving..." : "Save for later"}</button><button type="button" className="continueAction" disabled={saving} onClick={() => save(true)}>Save &amp; Continue <ChevronRightIcon size={18} /></button></div></div>
        </section>

        <aside className="communicationSidebar">
          <SetupProgressPanel currentStep={3} estimated="7 minutes" className="sidebarCard communicationProgressCard" progressClassName="sidebarProgressBar communicationProgressBar" />
          {channel === "webchat" ? <WebChatSidebar /> : <section className="sidebarCard communicationWhyCard"><h2>Connect what you need</h2><p>Web chat is available immediately. Phone, SMS and WhatsApp can be completed before go-live without blocking the rest of onboarding.</p><div className="communicationBenefits"><div className="communicationBenefit"><span className="benefitIcon green"><CheckIcon size={16} /></span><div><strong>Simple onboarding</strong><small>No provider credentials or callback URLs are required here.</small></div></div><div className="communicationBenefit"><span className="benefitIcon blue"><PhoneIcon size={16} /></span><div><strong>Finish later</strong><small>Save progress now and activate optional channels when you are ready.</small></div></div></div></section>}
        </aside>
      </div>
    </main>
  );
}
