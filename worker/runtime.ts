import { ensureQueue, stopBoss } from "@/server/jobs";
import {
  AUTH_PASSWORD_RESET_EMAIL,
  COMMERCE_WELCOME_EMAIL,
  SMS_INBOUND_RESPONSE,
  passwordResetEmailJobSchema,
  smsInboundResponseJobSchema,
  welcomeEmailJobSchema,
} from "@/server/jobs/queues";
import { sendPasswordResetEmail, sendWelcomeEmail } from "@/server/email/mailer";
import { logger } from "@/server/observability/logger";
import { smsWebhookService } from "@/server/sms/service";

export async function startWorker() {
  const authBoss = await ensureQueue(AUTH_PASSWORD_RESET_EMAIL);
  const commerceBoss = await ensureQueue(COMMERCE_WELCOME_EMAIL);
  const smsBoss = await ensureQueue(SMS_INBOUND_RESPONSE);

  await authBoss.work(AUTH_PASSWORD_RESET_EMAIL, async (jobs) => {
    for (const job of jobs) {
      const payload = passwordResetEmailJobSchema.parse(job.data);
      await sendPasswordResetEmail(payload);
    }
  });

  await commerceBoss.work(COMMERCE_WELCOME_EMAIL, async (jobs) => {
    for (const job of jobs) {
      const payload = welcomeEmailJobSchema.parse(job.data);
      await sendWelcomeEmail(payload);
    }
  });

  await smsBoss.work(SMS_INBOUND_RESPONSE, async (jobs) => {
    for (const job of jobs) {
      const payload = smsInboundResponseJobSchema.parse(job.data);
      await smsWebhookService.processInboundJob(payload);
    }
  });

  logger.info({ queues: [AUTH_PASSWORD_RESET_EMAIL, COMMERCE_WELCOME_EMAIL, SMS_INBOUND_RESPONSE] }, "AI Caller worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Stopping AI Caller worker");
    await stopBoss();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
