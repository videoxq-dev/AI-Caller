import { createBrandAsset } from "@/server/whitelabel/brand-asset-service";
import { brandAssetKindSchema } from "@/server/whitelabel/brand-schema";
import { requireWhitelabelAdmin } from "@/server/whitelabel/auth";
import { AppError, toErrorResponse } from "@/server/http/errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const context = await requireWhitelabelAdmin(request.headers);
    const form = await request.formData();
    const kind = brandAssetKindSchema.safeParse(form.get("kind"));
    if (!kind.success) throw new AppError("VALIDATION_ERROR", "Choose a valid brand image type.", 422);
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("VALIDATION_ERROR", "Choose an image to upload.", 422);
    const asset = await createBrandAsset(
      context.session.user.id,
      kind.data,
      new Uint8Array(await file.arrayBuffer()),
    );
    return Response.json({
      asset: { ...asset, url: `/api/whitelabel/brand/assets/${asset.id}` },
    }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
