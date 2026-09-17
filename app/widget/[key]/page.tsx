import { notFound } from "next/navigation";
import { WebchatWidget } from "@/components/webchat/webchat-widget";
import { getPublicWebchatWidget } from "@/server/webchat/repository";

export const dynamic = "force-dynamic";

export default async function WidgetPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const widget = await getPublicWebchatWidget(key);
  if (!widget) notFound();

  return (
    <WebchatWidget
      widgetKey={widget.publicKey}
      config={{
        businessName: widget.businessName,
        assistantName: widget.assistantName,
        greeting: widget.greeting,
      }}
    />
  );
}
