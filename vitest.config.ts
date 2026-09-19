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
    // This suite uses node:test and runs through npm run test:voice-readiness.
    exclude: [...configDefaults.exclude, "scripts/voice-provider-readiness.test.mjs"],
  },
});
