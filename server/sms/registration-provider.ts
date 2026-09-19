import { getHostedTelnyxCredentials } from "@/server/providers/telnyx-platform";
import { providerJson } from "@/server/providers/http";

const BASE = "https://api.telnyx.com/v2";
const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  PR: "Puerto Rico",
};


export type TelnyxBrand = {
  brandId?: string; status?: string; identityStatus?: string; failureReasons?: string;
};
export type TelnyxCampaign = {
  campaignId?: string; submissionStatus?: string; campaignStatus?: string;
  failureReasons?: string; embeddedLink?: boolean; description?: string;
  usecase?: string; referenceId?: string;
};
export type TelnyxAssignment = {
  phoneNumber?: string; campaignId?: string; telnyxCampaignId?: string; tcrCampaignId?: string;
  assignmentStatus?: string; failureReasons?: string;
};
export type TelnyxTollFreeRequest = {
  id?: string; verificationStatus?: string; reason?: string;
  phoneNumbers?: Array<{ phoneNumber?: string }>;
};
export type TelnyxRegistrationDraft = {
  legalName: string; contactName: string; contactEmail: string; contactPhone: string;
  website: string; privacyPolicyUrl: string; termsUrl: string; messagingUseCase: string;
  optInFlow: string; sampleMessages: string[]; categories: Array<"TRANSACTIONAL" | "MARKETING">;
  allowEmbeddedLinks: boolean;
  businessAddress: string; businessCity: string; businessState: string; businessZip: string;
  entityType: "PRIVATE_PROFIT" | "PUBLIC_PROFIT" | "NON_PROFIT" | "GOVERNMENT" | "SOLE_PROPRIETOR";
  vertical: string; ein: string; messageVolume: string; optInEvidenceUrl: string;
  stockSymbol: string; stockExchange: string;
};

function telnyxRequest(fetcher: typeof fetch) {
  const { apiKey } = getHostedTelnyxCredentials();
  return async <T>(path: string, method = "GET", body?: Record<string, unknown>) =>
    providerJson<T>(BASE + path, {
      method, headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, fetcher);
}

function splitContact(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) throw new Error("A business contact first and last name are required.");
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function brandPayload(draft: TelnyxRegistrationDraft) {
  const { firstName, lastName } = splitContact(draft.contactName);
  return {
    entityType: draft.entityType, displayName: draft.legalName.slice(0, 100),
    companyName: draft.legalName.slice(0, 100), country: "US",
    email: draft.contactEmail, businessContactEmail: draft.contactEmail,
    vertical: draft.vertical, firstName, lastName, ein: draft.ein || undefined,
    phone: draft.contactPhone, street: draft.businessAddress, city: draft.businessCity,
    ...(draft.entityType === "SOLE_PROPRIETOR" ? { mobilePhone: draft.contactPhone } : {}),
    ...(draft.entityType === "PUBLIC_PROFIT" ? { stockSymbol: draft.stockSymbol, stockExchange: draft.stockExchange } : {}),
    state: draft.businessState, postalCode: draft.businessZip, website: draft.website,
    isReseller: false, mock: false,
  };
}

export function campaignPayload(draft: TelnyxRegistrationDraft, brandId: string, referenceId: string) {
  const marketing = draft.categories.includes("MARKETING");
  const transactional = draft.categories.includes("TRANSACTIONAL");
  const usecase = draft.entityType === "SOLE_PROPRIETOR" ? "SOLE_PROPRIETOR"
    : marketing && transactional ? "MIXED" : marketing ? "MARKETING" : "CUSTOMER_CARE";
  const brand = draft.legalName.slice(0, 65);
  return {
    brandId, referenceId, usecase, description: draft.messagingUseCase,
    ...(marketing && transactional ? { subUsecases: ["CUSTOMER_CARE", "MARKETING"] } : {}),
    messageFlow: draft.optInFlow, sample1: draft.sampleMessages[0], sample2: draft.sampleMessages[1],
    ...(draft.sampleMessages[2] ? { sample3: draft.sampleMessages[2] } : {}),
    ...(draft.sampleMessages[3] ? { sample4: draft.sampleMessages[3] } : {}),
    ...(draft.sampleMessages[4] ? { sample5: draft.sampleMessages[4] } : {}),
    embeddedLink: draft.allowEmbeddedLinks,
    ...(draft.allowEmbeddedLinks ? { embeddedLinkSample: draft.website } : {}),
    privacyPolicyLink: draft.privacyPolicyUrl,
    termsAndConditionsLink: draft.termsUrl,
    termsAndConditions: true, subscriberHelp: true, subscriberOptin: true, subscriberOptout: true,
    helpKeywords: "HELP", optinKeywords: "START,UNSTOP", optoutKeywords: "STOP,UNSUBSCRIBE",
    helpMessage: brand + ": For messaging help email " + draft.contactEmail + ". Reply STOP to unsubscribe.",
    optinMessage: brand + ": Thanks for subscribing to " + (marketing ? "business updates" : "appointment updates") +
      ". Msg frequency varies. Msg&data rates may apply. Reply HELP for help or STOP to opt out.",
    optoutMessage: brand + ": You are unsubscribed and will receive no further messages.",
    ageGated: false, autoRenewal: true, directLending: false,
  };
}

export function tollFreePayload(draft: TelnyxRegistrationDraft, phoneNumber: string) {
  const { firstName, lastName } = splitContact(draft.contactName);
  return {
    businessName: draft.legalName, corporateWebsite: draft.website,
    businessAddr1: draft.businessAddress, businessCity: draft.businessCity,
    businessState: US_STATE_NAMES[draft.businessState] ?? draft.businessState, businessZip: draft.businessZip,
    businessContactFirstName: firstName, businessContactLastName: lastName,
    businessContactEmail: draft.contactEmail, businessContactPhone: draft.contactPhone,
    messageVolume: draft.messageVolume, phoneNumbers: [{ phoneNumber }],
    useCase: draft.categories.includes("MARKETING")
      ? draft.categories.includes("TRANSACTIONAL") ? "Mixed" : "General Marketing"
      : "Appointments",
    useCaseSummary: draft.messagingUseCase.slice(0, 500),
    productionMessageContent: draft.sampleMessages.join("\n"),
    optInWorkflow: draft.optInFlow.slice(0, 500), optInWorkflowImageURLs: [{ url: draft.optInEvidenceUrl }],
    isvReseller: "AI Caller",
    additionalInformation: draft.messagingUseCase.slice(0, 500),
    privacyPolicyURL: draft.privacyPolicyUrl, termsAndConditionURL: draft.termsUrl,
    entityType: draft.entityType, optInKeywords: "START,UNSTOP",
    ...(draft.ein ? { businessRegistrationNumber: draft.ein.replace(/-/g, ""), businessRegistrationType: "EIN", businessRegistrationCountry: "US" } : {}),
    helpMessageResponse: draft.legalName + ": Contact " + draft.contactEmail + " for help, or reply STOP to unsubscribe.",
    optInConfirmationResponse: draft.legalName + ": You are subscribed. Reply STOP to opt out or HELP for help.",
  };
}

export function telnyxRegistrationClient(fetcher: typeof fetch = fetch) {
  const request = telnyxRequest(fetcher);
  return {
    createBrand: (draft: TelnyxRegistrationDraft) =>
      request<TelnyxBrand>("/10dlc/brand", "POST", brandPayload(draft)),
    getBrand: (id: string) => request<TelnyxBrand>("/10dlc/brand/" + encodeURIComponent(id)),
    requestSoleProprietorOtp: (id: string) => request<{ referenceId?: string }>(
      "/10dlc/brand/" + encodeURIComponent(id) + "/smsOtp", "POST", {
        pinSms: "Your Telnyx brand verification code is @OTP_PIN@. This expires in 24 hours.",
        successSms: "Your SMS brand is verified. Reply STOP to unsubscribe from verification notices.",
      }),
    verifySoleProprietorOtp: (id: string, pin: string) => request<unknown>(
      "/10dlc/brand/" + encodeURIComponent(id) + "/smsOtp", "PUT", { otpPin: pin }),
    getSoleProprietorOtpStatus: (id: string) => request<{ deliveryStatus?: string }>(
      "/10dlc/brand/" + encodeURIComponent(id) + "/smsOtp"),
    updateBrand: (id: string, draft: TelnyxRegistrationDraft) =>
      request<TelnyxBrand>("/10dlc/brand/" + encodeURIComponent(id), "PUT", brandPayload(draft)),
    createCampaign: (draft: TelnyxRegistrationDraft, brandId: string, referenceId: string) =>
      request<TelnyxCampaign>("/10dlc/campaignBuilder", "POST", campaignPayload(draft, brandId, referenceId)),
    getCampaign: (id: string) => request<TelnyxCampaign>("/10dlc/campaign/" + encodeURIComponent(id)),
    updateCampaign: (id: string, draft: TelnyxRegistrationDraft) => request<TelnyxCampaign>(
      "/10dlc/campaign/" + encodeURIComponent(id), "PUT", {
        messageFlow: draft.optInFlow, sample1: draft.sampleMessages[0], sample2: draft.sampleMessages[1],
        ...(draft.sampleMessages[2] ? { sample3: draft.sampleMessages[2] } : {}),
        ...(draft.sampleMessages[3] ? { sample4: draft.sampleMessages[3] } : {}),
        ...(draft.sampleMessages[4] ? { sample5: draft.sampleMessages[4] } : {}),
        helpMessage: "Reply HELP for assistance or STOP to unsubscribe.",
        autoRenewal: true,
      },
    ),
    appealCampaign: (id: string, reason: string) => request<{ appealed_at?: string }>(
      "/10dlc/campaign/" + encodeURIComponent(id) + "/appeal", "POST", { appeal_reason: reason },
    ),
    assignNumber: (phoneNumber: string, campaignId: string) =>
      request<TelnyxAssignment>("/10dlc/phone_number_campaigns", "POST", { phoneNumber, campaignId }),
    getAssignment: (phoneNumber: string) =>
      request<TelnyxAssignment>("/10dlc/phone_number_campaigns/" + encodeURIComponent(phoneNumber)),
    createTollFree: (draft: TelnyxRegistrationDraft, phoneNumber: string) =>
      request<TelnyxTollFreeRequest>("/messaging_tollfree/verification/requests", "POST", tollFreePayload(draft, phoneNumber)),
    updateTollFree: (id: string, draft: TelnyxRegistrationDraft, phoneNumber: string) =>
      request<TelnyxTollFreeRequest>("/messaging_tollfree/verification/requests/" + encodeURIComponent(id), "PATCH", tollFreePayload(draft, phoneNumber)),
    getTollFree: (id: string) =>
      request<TelnyxTollFreeRequest>("/messaging_tollfree/verification/requests/" + encodeURIComponent(id)),
    findTollFreeByNumber: async (phoneNumber: string) => {
      const params = new URLSearchParams({ page: "1", page_size: "30", phone_number: phoneNumber });
      const list = await request<{ records?: TelnyxTollFreeRequest[] }>(
        "/messaging_tollfree/verification/requests?" + params.toString(),
      );
      return (list.records ?? []).find((row) => row.phoneNumbers?.some((phone) => phone.phoneNumber === phoneNumber)) ?? null;
    },
  };
}
