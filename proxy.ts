import { NextResponse, type NextRequest } from "next/server";
import { isCanonicalAiCallerHost } from "@/server/whitelabel/request-host";

const HOLDING_PATH = "/api/whitelabel/domain-pending";

export function proxy(request: NextRequest) {
  if (isCanonicalAiCallerHost(request.headers.get("host"))) {
    return NextResponse.next();
  }

  // Avoid rewrite recursion. The route handler performs the authoritative
  // registry + entitlement check for every non-canonical host.
  if (request.nextUrl.pathname === HOLDING_PATH) {
    return NextResponse.next();
  }

  const target = request.nextUrl.clone();
  target.pathname = HOLDING_PATH;
  target.search = "";
  return NextResponse.rewrite(target);
}

export const config = {
  matcher: "/:path*",
};
