import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { createContact, listContacts } from "@/server/domain/core/repository";
import { contactInputSchema, contactListQuerySchema } from "@/server/domain/core/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { getContactCapacity } from "@/server/commerce/contact-capacity";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    const input = parseInput(contactListQuerySchema, query);
    const [contacts, capacity] = await Promise.all([
      listContacts(context.workspace.id, input),
      getContactCapacity(context.workspace.id),
    ]);
    return Response.json({ ...contacts, capacity });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(contactInputSchema, await request.json());
    const contact = await createContact(context.workspace.id, input);
    return Response.json({ contact }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
