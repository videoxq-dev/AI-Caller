import { getEnv, type AppEnv } from "@/server/env";

export type PlatformReadinessStatus = "READY" | "NEEDS_CONFIGURATION" | "NOT_IMPLEMENTED";

export type PlatformReadinessItem = {
  id: "google_calendar" | "microsoft_outlook" | "whatsapp" | "smtp" | "hosted_sms" | "hosted_ai" | "hosted_voice";
  label: string;
  category: "CALENDAR" | "MESSAGING" | "EMAIL" | "AI" | "VOICE";
  status: PlatformReadinessStatus;
  summary: string;
  missing: string[];
};

function configured(value: string | undefined) {
  return Boolean(value?.trim());
}

function item(
  input: Omit<PlatformReadinessItem, "status" | "missing"> & { requirements?: Array<[string, boolean]>; status?: PlatformReadinessStatus },
): PlatformReadinessItem {
  const missing = (input.requirements ?? []).filter(([, ready]) => !ready).map(([name]) => name);
  return {
    id: input.id,
    label: input.label,
    category: input.category,
    status: input.status ?? (missing.length ? "NEEDS_CONFIGURATION" : "READY"),
    summary: input.summary,
    missing,
  };
}

export function getPlatformReadiness(env: AppEnv): PlatformReadinessItem[] {
  const hostedSmsRequirements: Array<[string, boolean]> = env.HOSTED_SMS_PROVIDER === "twilio"
    ? [
        ["HOSTED_SMS_TWILIO_ACCOUNT_SID", configured(env.HOSTED_SMS_TWILIO_ACCOUNT_SID)],
        ["HOSTED_SMS_TWILIO_AUTH_TOKEN", configured(env.HOSTED_SMS_TWILIO_AUTH_TOKEN)],
      ]
    : env.HOSTED_SMS_PROVIDER === "plivo"
      ? [
          ["HOSTED_SMS_PLIVO_AUTH_ID", configured(env.HOSTED_SMS_PLIVO_AUTH_ID)],
          ["HOSTED_SMS_PLIVO_AUTH_TOKEN", configured(env.HOSTED_SMS_PLIVO_AUTH_TOKEN)],
        ]
      : [
          ["HOSTED_SMS_TELNYX_API_KEY", configured(env.HOSTED_SMS_TELNYX_API_KEY)],
          ["HOSTED_SMS_TELNYX_WEBHOOK_PUBLIC_KEY", configured(env.HOSTED_SMS_TELNYX_WEBHOOK_PUBLIC_KEY)],
        ];

  return [
    item({
      id: "google_calendar",
      label: "Google Calendar OAuth",
      category: "CALENDAR",
      summary: "Authorizes Google Calendar connections from the customer app.",
      requirements: [
        ["GOOGLE_OAUTH_CLIENT_ID", configured(env.GOOGLE_OAUTH_CLIENT_ID)],
        ["GOOGLE_OAUTH_CLIENT_SECRET", configured(env.GOOGLE_OAUTH_CLIENT_SECRET)],
      ],
    }),
    item({
      id: "microsoft_outlook",
      label: "Microsoft Outlook OAuth",
      category: "CALENDAR",
      summary: "Authorizes Microsoft Outlook calendar connections from the customer app.",
      requirements: [
        ["MICROSOFT_OAUTH_CLIENT_ID", configured(env.MICROSOFT_OAUTH_CLIENT_ID)],
        ["MICROSOFT_OAUTH_CLIENT_SECRET", configured(env.MICROSOFT_OAUTH_CLIENT_SECRET)],
      ],
    }),
    item({
      id: "whatsapp",
      label: "WhatsApp Embedded Signup",
      category: "MESSAGING",
      summary: "Powers the Meta Embedded Signup flow for WhatsApp Business assets.",
      requirements: [
        ["META_APP_ID", configured(env.META_APP_ID)],
        ["META_APP_SECRET", configured(env.META_APP_SECRET)],
        ["META_EMBEDDED_SIGNUP_CONFIG_ID", configured(env.META_EMBEDDED_SIGNUP_CONFIG_ID)],
        ["META_WEBHOOK_VERIFY_TOKEN", configured(env.META_WEBHOOK_VERIFY_TOKEN)],
      ],
    }),
    item({
      id: "smtp",
      label: "Transactional email",
      category: "EMAIL",
      summary: "Sends password-reset, invitation, welcome and other transactional messages.",
      requirements: [
        ["SMTP_URL", configured(env.SMTP_URL)],
        ["SMTP_FROM", configured(env.SMTP_FROM)],
      ],
    }),
    item({
      id: "hosted_sms",
      label: "Hosted SMS",
      category: "MESSAGING",
      summary: `Platform-managed SMS routing using the configured ${env.HOSTED_SMS_PROVIDER} adapter.`,
      requirements: hostedSmsRequirements,
    }),
    item({
      id: "hosted_ai",
      label: "Hosted AI",
      category: "AI",
      summary: `Platform-managed AI inference using the configured ${env.HOSTED_AI_PROVIDER} adapter.`,
      requirements: [["HOSTED_AI_API_KEY", configured(env.HOSTED_AI_API_KEY)]],
    }),
    item({
      id: "hosted_voice",
      label: "Hosted inbound voice",
      category: "VOICE",
      summary: "Platform-managed phone-number provisioning and hosted inbound voice are not implemented yet.",
      status: "NOT_IMPLEMENTED",
    }),
  ];
}

export function readPlatformReadiness() {
  return getPlatformReadiness(getEnv());
}
