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
import { PhoneNumberManager, type ManagedPhoneNumber } from "@/components/phone-number-manager";
import { WebChatSetup, WebChatSidebar } from "./webchat";
import "./communication.css";

type Channel = "phone" | "whatsapp" | "webchat";
type IntegrationSummary = { provider: string; status: "CONNECTED" | "ERROR" | "DISCONNECTED" };
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
  const [managedNumber, setManagedNumber] = useState<ManagedPhoneNumber | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/integrations", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (Array.isArray(payload?.integrations)) setIntegrations(payload.integrations);
      })
      .catch(() => showToast("Some communication settings could not be loaded. You can still continue setup.", "error"));
  }, []);

  const connected = useMemo(
    () => new Set(integrations.filter((item) => item.status === "CONNECTED").map((item) => item.provider)),
    [integrations],
  );
  const whatsappConnected = connected.has("whatsapp");

  async function save(completeStep: boolean) {
    if (completeStep && managedNumber?.status !== "ACTIVE") {
      setChannel("phone");
      showToast("Choose and activate your AI Caller phone number before continuing.", "error");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/setup/communication", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          voice: { mode: "HOSTED", provider: null, numberMode: "new", number: managedNumber?.phoneNumber ?? null },
          sms: {
            mode: "HOSTED",
            provider: null,
            numberMode: "same",
            number: managedNumber?.phoneNumber ?? null,
            displayName: "",
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
            <p>Choose a business phone number for calls and SMS, connect WhatsApp, and add web chat to your website.</p>
          </div>

          <div className="channelTabs channelTabsThree" role="tablist" aria-label="Communication channels">
            <button className={channel === "phone" ? "active" : ""} onClick={() => setChannel("phone")} type="button"><span className="channelTabIcon blue"><PhoneIcon size={21} /></span><span><strong>Phone &amp; SMS</strong><small>One managed business number</small></span></button>
            <button className={channel === "whatsapp" ? "active" : ""} onClick={() => setChannel("whatsapp")} type="button"><span className="channelTabIcon green"><MessageIcon size={20} /></span><span><strong>WhatsApp</strong><small>Connect your account</small></span></button>
            <button className={channel === "webchat" ? "active" : ""} onClick={() => setChannel("webchat")} type="button"><span className="channelTabIcon orange"><MessageIcon size={20} /></span><span><strong>Web Chat</strong><small>Add to your website</small></span></button>
          </div>

          {channel === "phone" && (
            <section className="channelSetupCard">
              <div className="communicationSectionHeading"><span className="sectionCircle blue"><PhoneIcon size={23} /></span><div><h2>Phone &amp; SMS</h2><p>Use one AI Caller-managed number for customer calls and text messages. Search by state, city or area code to find a local number.</p></div></div>
              <PhoneNumberManager onNumberChange={setManagedNumber} />
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
          {channel === "webchat" ? <WebChatSidebar /> : <section className="sidebarCard communicationWhyCard"><h2>Connect what you need</h2><p>Your AI Caller number handles both calls and SMS. Number setup, routing and renewals are managed for you and billed from your credit balance.</p><div className="communicationBenefits"><div className="communicationBenefit"><span className="benefitIcon green"><CheckIcon size={16} /></span><div><strong>One number for calls and SMS</strong><small>No carrier account, provider credentials or callback URLs are required.</small></div></div><div className="communicationBenefit"><span className="benefitIcon blue"><PhoneIcon size={16} /></span><div><strong>Local number search</strong><small>Filter by state, city or area code and AI Caller configures the number automatically.</small></div></div></div></section>}
        </aside>
      </div>
    </main>
  );
}
