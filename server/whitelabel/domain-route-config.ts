import path from "node:path";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";

export function getWhitelabelTraefikRouteConfig() {
  const env = getEnv();
  const serviceUrl = new URL(env.WHITELABEL_TRAEFIK_SERVICE_URL);
  if (!["http:", "https:"].includes(serviceUrl.protocol)
    || serviceUrl.username || serviceUrl.password
    || (serviceUrl.pathname && serviceUrl.pathname !== "/")
    || serviceUrl.search || serviceUrl.hash) {
    throw new AppError(
      "WHITELABEL_TRAEFIK_CONFIGURATION_INVALID",
      "The Whitelabel Traefik service URL must be a plain HTTP(S) origin.",
      503,
    );
  }
  if (env.WHITELABEL_DOMAIN_ROUTE_ENABLED
    && env.NODE_ENV === "production"
    && !path.isAbsolute(env.WHITELABEL_TRAEFIK_DYNAMIC_DIR)) {
    throw new AppError(
      "WHITELABEL_TRAEFIK_CONFIGURATION_INVALID",
      "Production Whitelabel routing requires an absolute Traefik dynamic directory.",
      503,
    );
  }
  return {
    enabled: env.WHITELABEL_DOMAIN_ROUTE_ENABLED,
    dynamicDir: env.WHITELABEL_TRAEFIK_DYNAMIC_DIR,
    entryPoint: env.WHITELABEL_TRAEFIK_ENTRYPOINT,
    certResolver: env.WHITELABEL_TRAEFIK_CERT_RESOLVER,
    serviceUrl: serviceUrl.origin,
  };
}
