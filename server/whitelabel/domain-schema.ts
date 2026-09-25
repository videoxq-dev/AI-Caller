import { z } from "zod";

export const claimWhitelabelDomainSchema = z.object({
  hostname: z.string().trim().min(1).max(500),
}).strict();
