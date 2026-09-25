export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return Response.json({
    status: "domain-ready",
    host: request.headers.get("host")?.toLowerCase() ?? "",
  }, {
    headers: { "cache-control": "no-store" },
  });
}
