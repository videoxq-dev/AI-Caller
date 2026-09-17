import { z } from "zod";

const emptyToNull = (value: unknown) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const optionalText = (max: number) => z.preprocess(emptyToNull, z.string().max(max).nullable().optional());
const optionalEmail = z.preprocess(
  emptyToNull,
  z.string().email().max(320).transform((value) => value.toLowerCase()).nullable().optional(),
);

export function normalizePhone(value: string) {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return trimmed;
  return `+${digits}`;
}

export const channelSchema = z.enum(["PHONE", "SMS", "WHATSAPP", "WEBCHAT"]);
export const leadStatusSchema = z.enum(["NEW", "QUALIFIED", "BOOKED", "WON", "LOST"]);
export const appointmentStatusSchema = z.enum(["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"]);

export const contactIdentityInputSchema = z.object({
  channel: channelSchema,
  externalId: z.string().trim().min(1).max(500),
}).transform((identity) => ({
  ...identity,
  normalizedValue: identity.channel === "WEBCHAT"
    ? identity.externalId.trim().toLowerCase()
    : normalizePhone(identity.externalId),
}));

export const contactInputSchema = z.object({
  name: optionalText(200),
  email: optionalEmail,
  phone: z.preprocess(emptyToNull, z.string().max(80).transform(normalizePhone).nullable().optional()),
  notes: optionalText(5000),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]).transform((tags) => {
    const seen = new Set<string>();
    return tags.filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }),
  identities: z.array(contactIdentityInputSchema).max(20).default([]),
}).refine((value) => Boolean(value.name || value.email || value.phone || value.identities.length), {
  message: "A contact requires a name, email, phone, or channel identity.",
});

export const leadInputSchema = z.object({
  status: leadStatusSchema.default("NEW"),
  intent: optionalText(1000),
  serviceRequested: optionalText(500),
  source: optionalText(100),
  estimatedValue: z.number().int().nonnegative().nullable().optional(),
  assignedUserId: optionalText(200),
});

export const messageInputSchema = z.object({
  channel: channelSchema,
  direction: z.enum(["INBOUND", "OUTBOUND", "INTERNAL"]),
  senderType: z.enum(["CUSTOMER", "AI", "USER", "SYSTEM"]),
  contentType: z.enum(["TEXT", "CALL_TRANSCRIPT", "APPOINTMENT_EVENT", "SYSTEM_EVENT"]).default("TEXT"),
  body: z.string().trim().min(1).max(100_000),
  provider: optionalText(100),
  externalMessageId: optionalText(500),
  status: optionalText(100),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const handlingModeInputSchema = z.object({
  mode: z.enum(["AI", "HUMAN"]),
  assignedUserId: optionalText(200),
});

export const appointmentInputSchema = z.object({
  contactId: z.string().uuid(),
  conversationId: z.string().uuid().nullable().optional(),
  serviceId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(500),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  timezone: z.string().trim().min(1).max(100),
  bookingSource: optionalText(100),
  notes: optionalText(5000),
  attendeeName: optionalText(200),
  attendeeEmail: optionalEmail,
}).refine((value) => value.endsAt.getTime() > value.startsAt.getTime(), {
  path: ["endsAt"],
  message: "Appointment end must be after its start.",
});

export const appointmentRescheduleSchema = z.object({
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  timezone: z.string().trim().min(1).max(100),
}).refine((value) => value.endsAt.getTime() > value.startsAt.getTime(), {
  path: ["endsAt"],
  message: "Appointment end must be after its start.",
});

export const appointmentStatusInputSchema = z.object({
  status: appointmentStatusSchema,
});

export const contactListQuerySchema = z.object({
  query: z.string().trim().max(200).default(""),
  status: leadStatusSchema.optional(),
  channel: channelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const appointmentListQuerySchema = z.object({
  status: appointmentStatusSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).refine((value) => !value.from || !value.to || value.to >= value.from, {
  path: ["to"],
  message: "The appointment range end must not be before its start.",
});

export type ContactInput = z.infer<typeof contactInputSchema>;
export type LeadInput = z.infer<typeof leadInputSchema>;
export type MessageInput = z.infer<typeof messageInputSchema>;
export type AppointmentInput = z.infer<typeof appointmentInputSchema>;
export type AppointmentRescheduleInput = z.infer<typeof appointmentRescheduleSchema>;
