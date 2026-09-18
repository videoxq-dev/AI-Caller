import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { hasWorkspacePermission, requireWorkspacePermission } from "@/server/auth/permissions";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { getManagedPhoneNumber, provisionManagedPhoneNumber } from "@/server/phone-numbers/service";
import { getCreditBalance } from "@/server/credits/service";
import { parseInput } from "@/server/http/validation";

const provisionSchema = z.object({
  phoneNumber: z.string().trim().regex(/^\+1\d{10}$/),
  requestId: z.string().uuid(),
  replaceCurrent: z.boolean().default(false),
});

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const canManage = hasWorkspacePermission(context.membership.role, "billing.manage");
    const [number, creditBalance] = await Promise.all([
      getManagedPhoneNumber(context.workspace.id),
      canManage ? getCreditBalance(context.workspace.id) : Promise.resolve(null),
    ]);
    const visibleNumber = number && !canManage ? {
      id: number.id,
      phoneNumber: number.phoneNumber,
      countryCode: number.countryCode,
      administrativeArea: number.administrativeArea,
      locality: number.locality,
      numberType: number.numberType,
      status: number.status,
      messagingReadiness: number.messagingReadiness,
      failureReason: number.failureReason,
    } : number;
    return Response.json({ number: visibleNumber, creditBalance, canManage }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "billing.manage");
    const input = parseInput(provisionSchema, await request.json());
    const number = await provisionManagedPhoneNumber(context.workspace.id, input);
    const status = number?.status === "ACTIVE" ? 201 : 202;
    return Response.json({ number }, { status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return toErrorResponse(new AppError("INVALID_PHONE_PROVISIONING_REQUEST", "Choose a valid available phone number.", 422));
    }
    return toErrorResponse(error);
  }
}
