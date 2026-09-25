import { resolveWhitelabelHoldingHost } from "@/server/whitelabel/domain-host-guard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rawHost = request.headers.get("host") ?? "";
  const domain = await resolveWhitelabelHoldingHost(rawHost);
  if (!domain) {
    return Response.json(
      { error: { code: "WHITELABEL_HOST_NOT_FOUND", message: "This client platform is not available." } },
      { status: 404, headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } },
    );
  }
  if (request.headers.get("accept")?.includes("application/json")) {
    return Response.json({ status: "domain-ready", host: domain.hostname }, {
      headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
    });
  }
  return new Response(
    "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Client platform</title></head><body style=\"font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f9fc;color:#1f2937\"><main style=\"max-width:520px;padding:32px;text-align:center\"><h1 style=\"font-size:24px;margin:0 0 12px\">Your client platform is being configured.</h1><p style=\"margin:0;color:#64748b\">Please check back shortly.</p></main></body></html>",
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    },
  );
}
