import { logger } from "@/server/observability/logger";
import { getWhitelabelTraefikRouteConfig } from "@/server/whitelabel/domain-route-config";
import { recoverWhitelabelDomainRoutes } from "@/server/whitelabel/domain-route";
import { reconcilePendingWhitelabelDomainCertificates } from "@/server/whitelabel/domain-tls";

export function nextWhitelabelRouteScanOffset(
  currentOffset: number,
  result: { checked: number; removed: number },
  pageSize = 100,
) {
  if (result.checked < pageSize) return 0;
  // Removed rows leave the recovery query immediately. Subtract them so
  // domains that shifted forward are not skipped on the next bounded page.
  return Math.max(0, currentOffset + result.checked - result.removed);
}

export function createWhitelabelReconcileTimer(
  reconcile: () => void | Promise<void>,
  intervalMs = 5_000,
) {
  // Keep this timer referenced. This dedicated worker has no HTTP server or
  // other long-lived handle, so unref() would let Node exit after one pass.
  return setInterval(() => void reconcile(), intervalMs);
}

export async function startWhitelabelEdgeReconciler() {
  const config = getWhitelabelTraefikRouteConfig();
  logger.info({
    enabled: config.enabled,
    dynamicDir: config.dynamicDir,
    entryPoint: config.entryPoint,
    certResolver: config.certResolver,
  }, "Whitelabel edge reconciler started");

  let running = false;
  let routeScanOffset = 0;
  const reconcile = async () => {
    if (running) return;
    running = true;
    try {
      const routes = await recoverWhitelabelDomainRoutes(100, routeScanOffset);
      // A bounded scan must still eventually reach every domain, including
      // when healthy rows do not change their updatedAt each iteration.
      routeScanOffset = nextWhitelabelRouteScanOffset(routeScanOffset, routes, 100);
      if (routes.removed > 0 || routes.failed > 0) {
        logger.info(routes, "Reconciled Whitelabel Traefik routes");
      }
      if (config.enabled) {
        const certificates = await reconcilePendingWhitelabelDomainCertificates(40);
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
  const timer = createWhitelabelReconcileTimer(reconcile);

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Stopping Whitelabel edge reconciler");
    clearInterval(timer);
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
