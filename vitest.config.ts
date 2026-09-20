import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Database suites truncate shared tables: do not run test files concurrently.
    fileParallelism: false,
    // These suites use node:test and runs through npm run test:voice-readiness.
    exclude: [...configDefaults.exclude, "scripts/voice-provider-readiness.test.mjs", "scripts/verify-deployment-db.test.mjs", "scripts/inspect-deployos-postgres.test.mjs"],
  },
});
