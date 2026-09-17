import { JvzooCommerceAdapter } from "@/server/commerce/jvzoo";
import { processCommerceEvent } from "@/server/commerce/service";
import { toErrorResponse } from "@/server/http/errors";

const adapter = new JvzooCommerceAdapter();

export async function POST(request: Request) {
  try {
    const event = await adapter.verifyAndNormalize(request);
    const result = await processCommerceEvent(event);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
