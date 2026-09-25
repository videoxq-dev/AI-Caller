import { logger } from "@/server/observability/logger";
import { getWhitelabelTraefikRouteConfig } from "@/server/whitelabel/domain-route-config";
import { recoverWhitelabelDomainRoutes } from "@/server/whitelabel/domain-route";

export async function startWhitelabelEdgeReconciler() {
  const config = getWhitelabelTraefikRouteConfig();
  logger.info({
    enabled: config.enabled,
    dynamicDir: config.dynamicDir,
    entryPoint: config.entryPoint,
    certResolver: config.certResolver,
  }, "Whitelabel edge reconciler started");

  let running = false;
  const reconcile = async () => {
    if (running) return;
    running = true;
    try {
      const result = await recoverWhitelabelDomainRoutes(100);
      if (result.checked > 0 || result.failed > 0) {
        logger.info(result, "Reconciled Whitelabel Traefik routes");
      }
    } catch (error) {
      logger.error({ err: error }, "Whitelabel edge reconciliation failed");
    } finally {
      running = false;
    }
  };

  await reconcile();
  const timer = setInterval(() => void reconcile(), 5_000);
  timer.unref();

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Stopping Whitelabel edge reconciler");
    clearInterval(timer);
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
