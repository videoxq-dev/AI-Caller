import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "@/server/env";
import { getWhitelabelTraefikRouteConfig } from "./domain-route-config";

describe("F12-D Traefik route configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("requires an absolute mounted dynamic directory when production routing is enabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WHITELABEL_DOMAIN_ROUTE_ENABLED", "true");
    vi.stubEnv("WHITELABEL_TRAEFIK_DYNAMIC_DIR", ".data/traefik");
    resetEnvForTests();
    expect(() => getWhitelabelTraefikRouteConfig())
      .toThrow("absolute Traefik dynamic directory");
  });

  it("accepts the DeployOS worker mount and plain internal web origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WHITELABEL_DOMAIN_ROUTE_ENABLED", "true");
    vi.stubEnv("WHITELABEL_TRAEFIK_DYNAMIC_DIR", "/app/.data/traefik-domains");
    vi.stubEnv("WHITELABEL_TRAEFIK_SERVICE_URL", "http://aicaller-web:8080");
    resetEnvForTests();
    expect(getWhitelabelTraefikRouteConfig()).toMatchObject({
      enabled: true,
      dynamicDir: "/app/.data/traefik-domains",
      entryPoint: "websecure",
      certResolver: "letsencrypt",
      serviceUrl: "http://aicaller-web:8080",
    });
  });

  it("rejects a service URL containing credentials or an application path", () => {
    vi.stubEnv("WHITELABEL_TRAEFIK_SERVICE_URL", "http://user:pass@aicaller-web:8080/private");
    resetEnvForTests();
    expect(() => getWhitelabelTraefikRouteConfig())
      .toThrow("plain HTTP(S) origin");
  });

  it("permits a relative local directory while route writes remain disabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WHITELABEL_DOMAIN_ROUTE_ENABLED", "false");
    vi.stubEnv("WHITELABEL_TRAEFIK_DYNAMIC_DIR", ".data/traefik");
    resetEnvForTests();
    expect(getWhitelabelTraefikRouteConfig()).toMatchObject({
      enabled: false,
      dynamicDir: ".data/traefik",
    });
  });
});
