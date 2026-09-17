import { ensureQueue, stopBoss } from "@/server/jobs";
import { AUTH_PASSWORD_RESET_EMAIL, passwordResetEmailJobSchema } from "@/server/jobs/queues";
import { sendPasswordResetEmail } from "@/server/email/mailer";
import { logger } from "@/server/observability/logger";

export async function startWorker() {
  const boss = await ensureQueue(AUTH_PASSWORD_RESET_EMAIL);

  await boss.work(AUTH_PASSWORD_RESET_EMAIL, { batchSize: 5 }, async (jobs) => {
    for (const job of jobs) {
      const payload = passwordResetEmailJobSchema.parse(job.data);
      await sendPasswordResetEmail(payload);
    }
  });

  logger.info({ queue: AUTH_PASSWORD_RESET_EMAIL }, "AI Caller worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Stopping AI Caller worker");
    await stopBoss();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
