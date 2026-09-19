import { notFound } from "next/navigation";
import { getPublicWebchatWidget } from "@/server/webchat/repository";
import { HostedSmsOptinForm } from "@/components/webchat/hosted-sms-optin-form";

export default async function HostedSmsOptinPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const widget = await getPublicWebchatWidget(key);
  if (!widget || !widget.smsTermsUrl) notFound();
  return <main style={{ minHeight: "100vh", background: "#f6f9fd", color: "#172640", padding: "clamp(16px,5vw,48px)" }}>
    <article style={{ maxWidth: 520, margin: "32px auto", background: "white", border: "1px solid #dde5ef", borderRadius: 16, padding: "clamp(18px,4vw,35px)" }}>
      <p style={{ color: "#1769ee", fontWeight: 750, fontSize: 12 }}>AI Caller · {widget.businessName}</p>
      <h1 style={{ margin: "10px 0" }}>SMS appointment updates</h1>
      <p style={{ color: "#60738b", lineHeight: 1.6 }}>Share your contact details and choose whether to receive SMS updates from {widget.businessName}. You can still use other business services without agreeing to SMS.</p>
      <HostedSmsOptinForm widgetKey={key} businessName={widget.businessName} termsUrl={widget.smsTermsUrl} marketingAllowed={widget.marketingProgramApproved} />
    </article>
  </main>;
}
