import { z } from "zod";
import { getBrandAssetForPurchaser } from "@/server/whitelabel/brand-asset-service";
import { requireWhitelabelAdmin } from "@/server/whitelabel/auth";
import { parseInput } from "@/server/http/validation";
import { toErrorResponse } from "@/server/http/errors";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  try {
    const context = await requireWhitelabelAdmin(request.headers);
    const { assetId } = await params;
    const id = parseInput(z.string().uuid(), assetId);
    const asset = await getBrandAssetForPurchaser(context.session.user.id, id);
    const body = asset.bytes.buffer.slice(
      asset.bytes.byteOffset,
      asset.bytes.byteOffset + asset.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "content-type": asset.contentType,
        "cache-control": "private,max-age=3600",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
