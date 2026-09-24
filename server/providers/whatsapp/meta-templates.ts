import { z } from "zod";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import { providerJson } from "@/server/providers/http";

const templateName = z.string().trim().regex(/^[a-z][a-z0-9_]{0,511}$/, "Use lowercase letters, numbers, and underscores; start with a letter.");
const language = z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/, "Choose a valid template language.");
export const templateCursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9+\/_=-]+$/);

export const createWhatsAppTemplateSchema = z.object({
  name: templateName,
  language,
  category: z.enum(["UTILITY", "MARKETING"]),
  body: z.string().trim().min(1).max(1024),
  footer: z.string().trim().max(60).default(""),
  samples: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
}).strict().superRefine((input, ctx) => {
  const matches = [...input.body.matchAll(/{{(\d+)}}/g)].map(match => Number(match[1]));
  const unique = [...new Set(matches)];
  if (unique.length > 10 || unique.some((value, index) => value !== index + 1)
    || /{{|}}/.test(input.body.replace(/{{\d+}}/g, ""))) {
    ctx.addIssue({ code: "custom", path: ["body"], message: "Use consecutive placeholders {{1}}, {{2}}, and so on." });
  }
  if (input.samples.length !== unique.length) {
    ctx.addIssue({ code: "custom", path: ["samples"], message: "Provide one example for every numbered placeholder." });
  }
});
export type CreateWhatsAppTemplate = z.infer<typeof createWhatsAppTemplateSchema>;

/** A BODY may reuse {{1}}, but its unique positional parameters must be consecutive. */
export function approvedWhatsAppParameterCount(body: string) {
  const matches = [...body.matchAll(/{{(\d+)}}/g)].map(match => Number(match[1]));
  const unique = [...new Set(matches)].sort((left, right) => left - right);
  if (unique.length > 10 || unique.some((value, index) => value !== index + 1)
    || /{{|}}/.test(body.replace(/{{\d+}}/g, ""))) {
    throw new AppError("WHATSAPP_TEMPLATE_UNSUPPORTED",
      "This template does not use supported consecutive BODY placeholders.", 409);
  }
  return unique.length;
}


const graphTemplate = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  language: z.string().min(1),
  category: z.string().min(1),
  status: z.string().min(1),
  components: z.array(z.object({
    type: z.string(),
    text: z.string().optional(),
  }).passthrough()).default([]),
  rejected_reason: z.string().nullable().optional(),
}).passthrough();
const graphList = z.object({
  data: z.array(graphTemplate).max(100),
  paging: z.object({
    cursors: z.object({ after: z.string().optional() }).optional(),
    next: z.string().optional(),
  }).optional(),
}).passthrough();
const graphSubmission = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  category: z.string().min(1),
}).passthrough();

function publicTemplate(item: z.infer<typeof graphTemplate>) {
  return {
    id: item.id,
    name: item.name,
    language: item.language,
    category: item.category,
    status: item.status,
    body: item.components.find(component => component.type.toUpperCase() === "BODY")?.text ?? "",
    footer: item.components.find(component => component.type.toUpperCase() === "FOOTER")?.text ?? "",
    rejectionReason: item.rejected_reason ?? null,
    textOnly: item.components.every(component => ["BODY", "FOOTER"].includes(component.type.toUpperCase())),
  };
}

// Never follow Meta's next URL: only accept its bounded cursor and construct a
// fixed Graph API endpoint for the authenticated workspace's WABA.
export function createMetaTemplateClient(
  config: { accessToken: string; wabaId: string; graphApiVersion?: string },
  fetcher: typeof fetch = fetch,
) {
  if (!config.accessToken || !/^\d{1,30}$/.test(config.wabaId)) {
    throw new AppError("WHATSAPP_ACCOUNT_INVALID", "WhatsApp account configuration is incomplete.", 409);
  }
  const version = config.graphApiVersion ?? getEnv().META_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version)) throw new Error("Invalid Meta Graph API version.");
  const endpoint = `https://graph.facebook.com/${version}/${config.wabaId}/message_templates`;
  const headers = { authorization: `Bearer ${config.accessToken}` };
  return {
    async list(after?: string) {
      const cursor = after ? templateCursorSchema.parse(after) : null;
      const url = `${endpoint}?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
      const result = graphList.parse(await providerJson<unknown>(url, { headers }, fetcher));
      const next = result.paging?.next ? result.paging?.cursors?.after ?? null : null;
      if (next && !templateCursorSchema.safeParse(next).success) {
        throw new AppError("WHATSAPP_TEMPLATE_PAGE_INVALID", "Meta returned an invalid template page.", 502);
      }
      return { items: result.data.map(publicTemplate), nextCursor: next };
    },
    async approved(name: string, languageCode: string) {
      const parsedName = templateName.parse(name);
      const parsedLanguage = language.parse(languageCode);
      // Name-filtered and bounded on the connected WABA; never trust a
      // client-supplied account or follow an arbitrary provider URL.
      const result = graphList.parse(await providerJson<unknown>(
        `${endpoint}?name=${encodeURIComponent(parsedName)}&limit=100`,
        { headers }, fetcher,
      ));
      const match = result.data.find(item =>
        item.name === parsedName && item.language === parsedLanguage);
      if (!match || match.status !== "APPROVED"
        || !["UTILITY", "MARKETING"].includes(match.category)) {
        throw new AppError("WHATSAPP_TEMPLATE_NOT_APPROVED",
          "This template and language are not currently approved for sending.", 409);
      }
      const template = publicTemplate(match);
      if (!template.textOnly) {
        throw new AppError("WHATSAPP_TEMPLATE_UNSUPPORTED",
          "This template includes a header or buttons; choose a text-only template.", 409);
      }
      if (!template.body) {
        throw new AppError("WHATSAPP_TEMPLATE_UNSUPPORTED",
          "This template has no text body usable by this automation.", 409);
      }
      approvedWhatsAppParameterCount(template.body);
      return template;
    },
    async submit(input: CreateWhatsAppTemplate) {
      const parsed = createWhatsAppTemplateSchema.parse(input);
      const components: Array<Record<string, unknown>> = [{
        type: "BODY",
        text: parsed.body,
        ...(parsed.samples.length ? { example: { body_text: [parsed.samples] } } : {}),
      }];
      if (parsed.footer) components.push({ type: "FOOTER", text: parsed.footer });
      const result = graphSubmission.parse(await providerJson<unknown>(endpoint, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          name: parsed.name,
          language: parsed.language,
          category: parsed.category,
          components,
        }),
      }, fetcher));
      // Submission never means approved; retain the actual Meta status.
      return { id: result.id, name: parsed.name, language: parsed.language,
        category: result.category, status: result.status };
    },
  };
}
