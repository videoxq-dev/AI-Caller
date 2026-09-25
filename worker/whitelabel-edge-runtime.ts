import { logger } from "@/server/observability/logger";
import { getWhitelabelTraefikRouteConfig } from "@/server/whitelabel/domain-route-config";
import { recoverWhitelabelDomainRoutes } from "@/server/whitelabel/domain-route";
import { reconcilePendingWhitelabelDomainCertificates } from "@/server/whitelabel/domain-tls";

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
      const routes = await recoverWhitelabelDomainRoutes(100);
      if (routes.checked > 0 || routes.failed > 0) {
        logger.info(routes, "Reconciled Whitelabel Traefik routes");
      }
      if (config.enabled) {
        const certificates = await reconcilePendingWhitelabelDomainCertificates(50);
        if (certificates.checked > 0 || certificates.failed > 0) {
          logger.info(certificates, "Reconciled Whitelabel TLS readiness");
        }
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
