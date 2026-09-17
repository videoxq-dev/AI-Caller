import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { startWorker } = await import("./runtime");
  await startWorker();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
