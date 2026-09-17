import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { createFAQ, getAgentSetup } from "@/server/domain/onboarding/repository";
import { faqInputSchema } from "@/server/domain/onboarding/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const data = await getAgentSetup(context.workspace.id);
    return Response.json({ faqs: data.faqs });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(faqInputSchema, await request.json());
    return Response.json({ faq: await createFAQ(context.workspace.id, input) }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
