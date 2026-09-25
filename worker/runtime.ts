import { enqueueUniqueJob, ensureQueue, stopBoss } from "@/server/jobs";
import { recoverBookingCommands } from "@/server/booking/execution";
import {
  AUTH_PASSWORD_RESET_EMAIL,
  COMMERCE_WELCOME_EMAIL,
  ADMIN_USER_WELCOME_EMAIL,
  TEAM_INVITATION_EMAIL,
  SMS_INBOUND_RESPONSE,
  WHATSAPP_INBOUND_RESPONSE,
  VOICE_RESPOND_TURN,
  voiceRespondTurnJobSchema,
  AUTOMATION_DISPATCH_EVENT,
  AUTOMATION_EXECUTE_RUN,
  passwordResetEmailJobSchema,
  teamInvitationEmailJobSchema,
  smsInboundResponseJobSchema,
  whatsappInboundResponseJobSchema,
  automationDispatchEventJobSchema,
  automationExecuteRunJobSchema,
  whitelabelDomainReconcileJobSchema,
  WHITELABEL_DOMAIN_RECONCILE,
  welcomeEmailJobSchema,
  adminUserWelcomeEmailJobSchema,
} from "@/server/jobs/queues";
import { sendAdminUserWelcomeEmail, sendPasswordResetEmail, sendTeamInvitationEmail, sendWelcomeEmail } from "@/server/email/mailer";
import { logger } from "@/server/observability/logger";
import { smsWebhookService } from "@/server/sms/service";
import { processVoiceTurn } from "@/server/voice/turns";
import { processPendingSmsRegistrations } from "@/server/sms/registration-service";
import { whatsAppWebhookService } from "@/server/whatsapp/service";
import { dispatchAutomationEvent } from "@/server/automations/dispatcher";
import { executeAutomationRun } from "@/server/automations/executor";
import { listRecoverableAutomationRuns, listUndispatchedAutomationEvents } from "@/server/automations/repository";
import { processDuePhoneNumberRenewals, processPendingPhoneNumberProvisioning, processPendingPhoneNumberReleases } from "@/server/phone-numbers/service";
import { reconcileWhitelabelDomain } from "@/server/whitelabel/domain-reconcile";
import { recoverWhitelabelDomainRoutes } from "@/server/whitelabel/domain-route";

export async function startWorker() {
  const authBoss = await ensureQueue(AUTH_PASSWORD_RESET_EMAIL);
  const commerceBoss = await ensureQueue(COMMERCE_WELCOME_EMAIL);
  const adminUserBoss = await ensureQueue(ADMIN_USER_WELCOME_EMAIL);
  const teamBoss = await ensureQueue(TEAM_INVITATION_EMAIL);
  const smsBoss = await ensureQueue(SMS_INBOUND_RESPONSE);
  const whatsappBoss = await ensureQueue(WHATSAPP_INBOUND_RESPONSE);
  const voiceBoss = await ensureQueue(VOICE_RESPOND_TURN);
  const automationDispatchBoss = await ensureQueue(AUTOMATION_DISPATCH_EVENT);
  const automationExecuteBoss = await ensureQueue(AUTOMATION_EXECUTE_RUN);
  const whitelabelDomainBoss = await ensureQueue(WHITELABEL_DOMAIN_RECONCILE);

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

  await voiceBoss.work(VOICE_RESPOND_TURN, async (jobs) => {
    for (const job of jobs) {
      const payload = voiceRespondTurnJobSchema.parse(job.data);
      await processVoiceTurn(payload);
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

  await whitelabelDomainBoss.work(WHITELABEL_DOMAIN_RECONCILE, async (jobs) => {
    for (const job of jobs) {
      const payload = whitelabelDomainReconcileJobSchema.parse(job.data);
      const result = await reconcileWhitelabelDomain(payload.domainId);
      logger.info({
        domainId: payload.domainId,
        status: result.status,
        errorCode: result.lastErrorCode,
      }, "Reconciled Whitelabel custom domain");
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

  let bookingRecoveryRunning = false;
  const recoverBookings = async () => {
    if (bookingRecoveryRunning) return;
    bookingRecoveryRunning = true;
    try {
      const result = await recoverBookingCommands(50);
      if (result.confirmed > 0) logger.info(result, "Recovered durable appointment bookings");
      if (result.unresolved > 0) logger.warn(result, "Appointment booking commands need reconciliation");
    } catch (error) {
      logger.error({ err: error }, "Failed to recover durable appointment bookings");
    } finally {
      bookingRecoveryRunning = false;
    }
  };
  await recoverBookings();
  const bookingRecoveryTimer = setInterval(() => void recoverBookings(), 15_000);
  bookingRecoveryTimer.unref();

  let provisioningRunning = false;
  const reconcileManagedNumberProvisioning = async () => {
    if (provisioningRunning) return;
    provisioningRunning = true;
    try {
      const result = await processPendingPhoneNumberProvisioning(50);
      if (result.checked > 0) logger.info(result, "Reconciled managed phone number provisioning");
    } catch (error) {
      logger.error({ err: error }, "Failed to reconcile managed phone number provisioning");
    } finally {
      provisioningRunning = false;
    }
  };
  await reconcileManagedNumberProvisioning();
  const provisioningTimer = setInterval(() => void reconcileManagedNumberProvisioning(), 30_000);
  provisioningTimer.unref();

  let registrationRunning = false;
  const reconcileMessagingRegistration = async () => {
    if (registrationRunning) return;
    registrationRunning = true;
    try {
      const result = await processPendingSmsRegistrations(50);
      if (result.checked) logger.info(result, "Reconciled Telnyx SMS registrations");
    } catch (error) {
      logger.error({ err: error }, "Failed to reconcile SMS carrier registration");
    } finally { registrationRunning = false; }
  };
  await reconcileMessagingRegistration();
  const registrationTimer = setInterval(() => void reconcileMessagingRegistration(), 60_000);
  registrationTimer.unref();


  let whitelabelRouteRecoveryRunning = false;
  const recoverWhitelabelRoutes = async () => {
    if (whitelabelRouteRecoveryRunning) return;
    whitelabelRouteRecoveryRunning = true;
    try {
      const result = await recoverWhitelabelDomainRoutes(100);
      if (result.checked > 0) logger.info(result, "Recovered Whitelabel Traefik routes");
    } catch (error) {
      logger.error({ err: error }, "Failed to recover Whitelabel Traefik routes");
    } finally {
      whitelabelRouteRecoveryRunning = false;
    }
  };
  await recoverWhitelabelRoutes();
  const whitelabelRouteRecoveryTimer = setInterval(() => void recoverWhitelabelRoutes(), 30_000);
  whitelabelRouteRecoveryTimer.unref();

  let renewalRunning = false;
  const renewManagedNumbers = async () => {
    if (renewalRunning) return;
    renewalRunning = true;
    try {
      const [renewals, releases] = await Promise.all([
        processDuePhoneNumberRenewals(100),
        processPendingPhoneNumberReleases(50),
      ]);
      if (renewals.checked > 0) logger.info(renewals, "Processed managed phone number renewals");
      if (releases.checked > 0) logger.info(releases, "Processed managed phone number release retries");
    } catch (error) {
      logger.error({ err: error }, "Failed to process managed phone number renewals");
    } finally {
      renewalRunning = false;
    }
  };
  await renewManagedNumbers();
  const renewalTimer = setInterval(() => void renewManagedNumbers(), 60 * 60 * 1000);
  renewalTimer.unref();

  logger.info({ queues: [AUTH_PASSWORD_RESET_EMAIL, COMMERCE_WELCOME_EMAIL, ADMIN_USER_WELCOME_EMAIL, TEAM_INVITATION_EMAIL, SMS_INBOUND_RESPONSE, WHATSAPP_INBOUND_RESPONSE, VOICE_RESPOND_TURN, AUTOMATION_DISPATCH_EVENT, AUTOMATION_EXECUTE_RUN, WHITELABEL_DOMAIN_RECONCILE] }, "AI Caller worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Stopping AI Caller worker");
    clearInterval(recoveryTimer);
    clearInterval(bookingRecoveryTimer);
    clearInterval(provisioningTimer);
    clearInterval(registrationTimer);
    clearInterval(whitelabelRouteRecoveryTimer);
    clearInterval(renewalTimer);
    await stopBoss();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
