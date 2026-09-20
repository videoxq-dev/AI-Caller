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
    // Integration suites truncate shared database tables; isolate files to avoid cross-suite races.
    fileParallelism: false,
    // This suite uses node:test and runs through npm run test:voice-readiness.
    exclude: [...configDefaults.exclude, "scripts/voice-provider-readiness.test.mjs"],
  },
});
