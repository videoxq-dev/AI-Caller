import { z } from "zod";

export const webchatSessionInputSchema = z.object({
  widgetKey: z.string().trim().min(8).max(200),
  visitorId: z.string().trim().min(8).max(200).optional(),
  sessionToken: z.string().trim().min(20).max(500).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()).optional(),
});

export const webchatMessageInputSchema = z.object({
  clientMessageId: z.string().uuid(),
  message: z.string().trim().min(1).max(4000),
});

export type WebchatSessionInput = z.infer<typeof webchatSessionInputSchema>;
export type WebchatMessageInput = z.infer<typeof webchatMessageInputSchema>;
