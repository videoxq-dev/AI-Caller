import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { startWhitelabelEdgeReconciler } = await import("./whitelabel-edge-runtime");
  await startWhitelabelEdgeReconciler();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
