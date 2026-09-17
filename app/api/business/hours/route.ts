import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getBusinessSetup, saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { businessHourSchema } from "@/server/domain/onboarding/schemas";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const hoursInputSchema = z.object({ hours: z.array(businessHourSchema).length(7), completeStep: z.boolean().default(false) });

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(hoursInputSchema, await request.json());
    const current = await getBusinessSetup(context.workspace.id);
    if (!current.profile) throw new AppError("BUSINESS_PROFILE_REQUIRED", "Save the business profile before business hours.", 409);
    await saveBusinessSetup(context.workspace.id, {
      businessName: current.profile.businessName,
      industry: current.profile.industry,
      websiteUrl: current.profile.websiteUrl,
      phone: current.profile.phone,
      address: current.profile.address,
      city: current.profile.city,
      state: current.profile.state,
      postalCode: current.profile.postalCode,
      country: current.profile.country,
      serviceRadius: current.profile.serviceRadius,
      timezone: current.profile.timezone,
      summary: current.profile.summary,
      hours: input.hours,
      completeStep: input.completeStep,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
