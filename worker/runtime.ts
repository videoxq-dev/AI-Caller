import { enqueueUniqueJob, ensureQueue, stopBoss } from "@/server/jobs";
import {
  AUTH_PASSWORD_RESET_EMAIL,
  COMMERCE_WELCOME_EMAIL,
  ADMIN_USER_WELCOME_EMAIL,
  TEAM_INVITATION_EMAIL,
  SMS_INBOUND_RESPONSE,
  WHATSAPP_INBOUND_RESPONSE,
  AUTOMATION_DISPATCH_EVENT,
  AUTOMATION_EXECUTE_RUN,
  passwordResetEmailJobSchema,
  teamInvitationEmailJobSchema,
  smsInboundResponseJobSchema,
  whatsappInboundResponseJobSchema,
  automationDispatchEventJobSchema,
  automationExecuteRunJobSchema,
  welcomeEmailJobSchema,
  adminUserWelcomeEmailJobSchema,
} from "@/server/jobs/queues";
import { sendAdminUserWelcomeEmail, sendPasswordResetEmail, sendTeamInvitationEmail, sendWelcomeEmail } from "@/server/email/mailer";
import { logger } from "@/server/observability/logger";
import { smsWebhookService } from "@/server/sms/service";
import { whatsAppWebhookService } from "@/server/whatsapp/service";
import { dispatchAutomationEvent } from "@/server/automations/dispatcher";
import { executeAutomationRun } from "@/server/automations/executor";
import { listRecoverableAutomationRuns, listUndispatchedAutomationEvents } from "@/server/automations/repository";
import { processDuePhoneNumberRenewals } from "@/server/phone-numbers/service";

export async function startWorker() {
  const authBoss = await ensureQueue(AUTH_PASSWORD_RESET_EMAIL);
  const commerceBoss = await ensureQueue(COMMERCE_WELCOME_EMAIL);
  const adminUserBoss = await ensureQueue(ADMIN_USER_WELCOME_EMAIL);
  const teamBoss = await ensureQueue(TEAM_INVITATION_EMAIL);
  const smsBoss = await ensureQueue(SMS_INBOUND_RESPONSE);
  const whatsappBoss = await ensureQueue(WHATSAPP_INBOUND_RESPONSE);
  const automationDispatchBoss = await ensureQueue(AUTOMATION_DISPATCH_EVENT);
  const automationExecuteBoss = await ensureQueue(AUTOMATION_EXECUTE_RUN);

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

  await adminUserBoss.work(ADMIN_USER_WELCOME_EMAIL, async (jobs) => {
    for (const job of jobs) {
      const payload = adminUserWelcomeEmailJobSchema.parse(job.data);
      await sendAdminUserWelcomeEmail(payload);
    }
  });

  await teamBoss.work(TEAM_INVITATION_EMAIL, async (jobs) => {
    for (const job of jobs) {
      const payload = teamInvitationEmailJobSchema.parse(job.data);
      await sendTeamInvitationEmail(payload);
    }
  });

  await smsBoss.work(SMS_INBOUND_RESPONSE, async (jobs) => {
    for (const job of jobs) {
      const payload = smsInboundResponseJobSchema.parse(job.data);
      await smsWebhookService.processInboundJob(payload);
    }
  });

  await whatsappBoss.work(WHATSAPP_INBOUND_RESPONSE, async (jobs) => {
    for (const job of jobs) {
      const payload = whatsappInboundResponseJobSchema.parse(job.data);
      await whatsAppWebhookService.processInboundJob(payload);
    }
  });

  await automationDispatchBoss.work(AUTOMATION_DISPATCH_EVENT, async (jobs) => {
    for (const job of jobs) {
      const payload = automationDispatchEventJobSchema.parse(job.data);
      await dispatchAutomationEvent(payload.workspaceId, payload.eventId);
    }
  });

  await automationExecuteBoss.work(AUTOMATION_EXECUTE_RUN, async (jobs) => {
    for (const job of jobs) {
      const payload = automationExecuteRunJobSchema.parse(job.data);
      await executeAutomationRun(payload.workspaceId, payload.runId);
    }
  });

  let recoveryRunning = false;
  const recoverAutomationEvents = async () => {
    if (recoveryRunning) return;
    recoveryRunning = true;
    try {
      const [events, runs] = await Promise.all([
        listUndispatchedAutomationEvents(100),
        listRecoverableAutomationRuns(100),
      ]);
      for (const event of events) {
        await enqueueUniqueJob(AUTOMATION_DISPATCH_EVENT, event.id, {
          workspaceId: event.workspaceId,
          eventId: event.id,
        });
      }
      for (const run of runs) {
        await enqueueUniqueJob(AUTOMATION_EXECUTE_RUN, run.id, {
          workspaceId: run.workspaceId,
          runId: run.id,
        });
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to recover undispatched automation events");
    } finally {
      recoveryRunning = false;
    }
  };

  await recoverAutomationEvents();
  const recoveryTimer = setInterval(() => void recoverAutomationEvents(), 15_000);
  recoveryTimer.unref();

  let renewalRunning = false;
  const renewManagedNumbers = async () => {
    if (renewalRunning) return;
    renewalRunning = true;
    try {
      const result = await processDuePhoneNumberRenewals(100);
      if (result.checked > 0) logger.info(result, "Processed managed phone number renewals");
    } catch (error) {
      logger.error({ err: error }, "Failed to process managed phone number renewals");
    } finally {
      renewalRunning = false;
    }
  };
  await renewManagedNumbers();
  const renewalTimer = setInterval(() => void renewManagedNumbers(), 60 * 60 * 1000);
  renewalTimer.unref();

  logger.info({ queues: [AUTH_PASSWORD_RESET_EMAIL, COMMERCE_WELCOME_EMAIL, ADMIN_USER_WELCOME_EMAIL, TEAM_INVITATION_EMAIL, SMS_INBOUND_RESPONSE, WHATSAPP_INBOUND_RESPONSE, AUTOMATION_DISPATCH_EVENT, AUTOMATION_EXECUTE_RUN] }, "AI Caller worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Stopping AI Caller worker");
    clearInterval(recoveryTimer);
    clearInterval(renewalTimer);
    await stopBoss();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
