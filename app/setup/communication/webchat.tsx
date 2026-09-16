"use client";

import { useMemo, useState } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  InfoIcon,
  LogoMark,
  MessageIcon,
  SparkleIcon,
  UsersIcon,
} from "@/components/icons";

type WidgetMode = "managed" | "custom";
type WidgetIcon = "chat" | "dots" | "bot" | "headset";

export function WebChatSetup() {
  const [mode, setMode] = useState<WidgetMode>("managed");
  const [primaryColor, setPrimaryColor] = useState("#2563EB");
  const [widgetStyle, setWidgetStyle] = useState("Modern (rounded)");
  const [position, setPosition] = useState("Bottom right");
  const [widgetIcon, setWidgetIcon] = useState<WidgetIcon>("chat");
  const [welcomeMessage, setWelcomeMessage] = useState("Hi! 👋 How can we help you today?");
  const [copied, setCopied] = useState(false);

  const embedCode = useMemo(
    () => `<script src="https://app.aicaller.com/widget.js"\n  data-widget-id="your-widget-id"\n  data-color="${primaryColor}"\n  data-position="${position.toLowerCase().replace(" ", "-")}"\n></script>`,
    [position, primaryColor],
  );

  async function copyEmbedCode() {
    try {
      await navigator.clipboard.writeText(embedCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="channelSetupCard webchatSetupCard">
      <div className="communicationSectionHeading">
        <span className="sectionCircle orange"><MessageIcon size={23} /></span>
        <div>
          <h2>Web Chat Setup</h2>
          <p>Add a chat widget to your website so visitors can chat with your AI assistant in real time.</p>
        </div>
      </div>

      <div className="webchatBlock">
        <h3>Choose how to set up web chat</h3>
        <div className="choiceGrid webchatModeGrid">
          <button type="button" className={`choiceCard webchatModeCard ${mode === "managed" ? "selected" : ""}`} onClick={() => setMode("managed")}>
            <span className="radioDot" />
            <span className="choiceText webchatChoiceText">
              <strong>Use our managed widget (recommended)</strong>
              <small>Get a beautiful, customizable chat widget with one-click installation.</small>
              <span className="webchatChecks"><i><CheckIcon size={12} /> No technical skills needed</i><i><CheckIcon size={12} /> Fully customizable</i><i><CheckIcon size={12} /> Works on any website</i></span>
            </span>
            <span className="webchatBrand"><LogoMark size={25} /> AI Caller</span>
          </button>

          <button type="button" className={`choiceCard webchatModeCard ${mode === "custom" ? "selected" : ""}`} onClick={() => setMode("custom")}>
            <span className="radioDot" />
            <span className="choiceText webchatChoiceText">
              <strong>Use my own widget (advanced)</strong>
              <small>Connect a custom widget via our API.</small>
              <span className="webchatChecks"><i><CheckIcon size={12} /> Use your existing chat solution</i><i><CheckIcon size={12} /> Support for custom integrations</i><i className="mutedCheck">● Requires technical setup</i></span>
            </span>
          </button>
        </div>
      </div>

      <div className="webchatWorkspace">
        <div className="webchatConfigColumn">
          <section className="webchatPanel appearancePanel">
            <div className="webchatPanelHeading">
              <span className="webchatPanelIcon">🤖</span>
              <div><h3>Widget appearance</h3><p>Customize how the chat widget looks on your website.</p></div>
            </div>

            <div className="webchatAppearanceGrid">
              <label className="communicationField colorField">
                <span>Primary colour</span>
                <div className="colorControl"><input type="color" value={primaryColor} onChange={(event) => setPrimaryColor(event.target.value.toUpperCase())} /><input value={primaryColor} onChange={(event) => setPrimaryColor(event.target.value)} /></div>
              </label>
              <label className="communicationField"><span>Widget style</span><select value={widgetStyle} onChange={(event) => setWidgetStyle(event.target.value)}><option>Modern (rounded)</option><option>Compact</option><option>Minimal</option></select></label>
              <label className="communicationField"><span>Widget position</span><select value={position} onChange={(event) => setPosition(event.target.value)}><option>Bottom right</option><option>Bottom left</option></select></label>
              <div className="widgetIconField"><span>Widget icon</span><div className="widgetIconChoices">
                <button className={widgetIcon === "chat" ? "selected" : ""} type="button" onClick={() => setWidgetIcon("chat")}><MessageIcon size={18} /></button>
                <button className={widgetIcon === "dots" ? "selected" : ""} type="button" onClick={() => setWidgetIcon("dots")}>•••</button>
                <button className={widgetIcon === "bot" ? "selected" : ""} type="button" onClick={() => setWidgetIcon("bot")}>🤖</button>
                <button className={widgetIcon === "headset" ? "selected" : ""} type="button" onClick={() => setWidgetIcon("headset")}>🎧</button>
              </div></div>
              <label className="communicationField welcomeField"><span>Welcome message</span><textarea rows={2} maxLength={100} value={welcomeMessage} onChange={(event) => setWelcomeMessage(event.target.value)} /><small className="fieldCounter">{welcomeMessage.length}/100</small></label>
            </div>
          </section>

          <section className="webchatPanel embedPanel">
            <div className="webchatPanelHeading">
              <span className="webchatPanelIcon codeIcon">&lt;/&gt;</span>
              <div><h3>Embed on your website</h3><p>Add this code to your website&apos;s HTML, just before the closing &lt;/body&gt; tag.</p></div>
            </div>
            <div className="embedCodeBox">
              <pre>{embedCode}</pre>
              <button type="button" onClick={copyEmbedCode}>▣ {copied ? "Copied" : "Copy code"}</button>
            </div>
            <a className="installationGuide" href="#installation-guide">Need help? <strong>View installation guide →</strong></a>
          </section>
        </div>

        <section className="webchatPanel livePreviewPanel">
          <div className="livePreviewHeading"><h3>Live preview</h3><p>This is how the widget will appear on your website.</p></div>
          <div className={`widgetPreview ${widgetStyle.toLowerCase().includes("rounded") ? "rounded" : ""}`}>
            <div className="widgetPreviewHeader" style={{ background: primaryColor }}>
              <span className="widgetPreviewAvatar">🤖</span>
              <div><strong>AI Assistant</strong><small><i /> Online</small></div>
              <span className="minimizeWidget">—</span>
            </div>
            <div className="widgetPreviewBody">
              <div className="previewWelcome">{welcomeMessage}</div>
              <div className="quickActions"><button type="button">Book an appointment</button><button type="button">Ask a question</button><button type="button">Get a quote</button></div>
            </div>
            <div className="widgetPreviewComposer"><span>Type a message...</span><button type="button" style={{ background: primaryColor }}>➤</button></div>
            <div className="poweredBy">Powered by <strong>AI Caller</strong></div>
          </div>
        </section>
      </div>
    </section>
  );
}

export function WebChatSidebar() {
  return (
    <section className="sidebarCard communicationWhyCard webchatWhyCard">
      <h2>Why add web chat?</h2>
      <p>Turn your website visitors into customers. Your AI assistant can chat with visitors 24/7, answer questions, capture leads and book appointments — even when you&apos;re offline.</p>

      <div className="communicationBenefits webchatBenefits">
        <div className="communicationBenefit"><span className="benefitIcon green"><SparkleIcon size={16} /></span><div><strong>Capture more leads</strong><small>Engage visitors before they leave</small></div></div>
        <div className="communicationBenefit"><span className="benefitIcon purple"><ClockIcon size={16} /></span><div><strong>Answer instantly</strong><small>Provide 24/7 support</small></div></div>
        <div className="communicationBenefit"><span className="benefitIcon blue"><CalendarIcon size={16} /></span><div><strong>Book appointments</strong><small>Let customers book directly in chat</small></div></div>
        <div className="communicationBenefit"><span className="benefitIcon orange"><UsersIcon size={16} /></span><div><strong>Reduce workload</strong><small>Handle common questions automatically</small></div></div>
      </div>

      <div className="webchatIllustration" aria-hidden="true">
        <span className="illustrationNote webchatNote">Turn website<br />visitors into<br />customers!</span>
        <div className="browserIllustration"><div className="browserDots">•••</div><i /><i /><i /><span className="browserChatBubble">Hi! 👋<br />How can we help<br />you today?</span><span className="browserChatLauncher"><MessageIcon size={20} /><b>1</b></span></div>
      </div>

      <div className="editableNote communicationEditableNote">
        <span className="infoBubble"><InfoIcon size={18} /></span>
        <div><strong>You can customize these settings anytime from Settings.</strong><p>Change the appearance, welcome message or install on additional websites at any time.</p></div>
      </div>
    </section>
  );
}
