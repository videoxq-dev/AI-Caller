import { z } from "zod";

const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use a six-digit hex color.");
const optionalEmail = z.union([z.string().trim().email().max(320), z.literal("")])
  .transform((value) => value || null).nullable();
const optionalHttpsUrl = z.union([
  z.string().trim().url().max(500).refine((value) => new URL(value).protocol === "https:", "Support URL must use HTTPS."),
  z.literal(""),
]).transform((value) => value || null).nullable();

export const brandDraftSchema = z.object({
  name: z.string().trim().max(60),
  tagline: z.string().trim().max(120).nullable(),
  primaryColor: color,
  accentColor: color,
  logoAssetId: z.string().uuid().nullable(),
  iconAssetId: z.string().uuid().nullable(),
  faviconAssetId: z.string().uuid().nullable(),
  supportEmail: optionalEmail,
  supportUrl: optionalHttpsUrl,
}).strict();

export const brandPublishSchema = brandDraftSchema.superRefine((brand, ctx) => {
  if (brand.name.length < 2) {
    ctx.addIssue({ code: "custom", path: ["name"], message: "Brand name is required." });
  }
  if (!brand.supportEmail && !brand.supportUrl) {
    ctx.addIssue({ code: "custom", path: ["supportEmail"], message: "Add a support email or support URL." });
  }
});

export type BrandDraft = z.infer<typeof brandDraftSchema>;
export type PublishedBrand = BrandDraft;

export const DEFAULT_BRAND_DRAFT: BrandDraft = {
  name: "",
  tagline: null,
  primaryColor: "#2563EB",
  accentColor: "#0F172A",
  logoAssetId: null,
  iconAssetId: null,
  faviconAssetId: null,
  supportEmail: null,
  supportUrl: null,
};

export const saveBrandDraftSchema = z.object({
  expectedRevision: z.number().int().min(0),
  brand: brandDraftSchema,
}).strict();

export const publishBrandRequestSchema = z.object({
  expectedRevision: z.number().int().min(0),
}).strict();

export const revertBrandRequestSchema = z.object({
  version: z.number().int().positive(),
}).strict();

export const brandAssetKindSchema = z.enum(["LOGO", "ICON", "FAVICON"]);
export type BrandAssetKind = z.infer<typeof brandAssetKindSchema>;
