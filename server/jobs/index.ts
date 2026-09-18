import { PgBoss } from "pg-boss";
import { getEnv } from "@/server/env";
import { logger } from "@/server/observability/logger";

let bossPromise: Promise<PgBoss> | null = null;

async function createBoss(): Promise<PgBoss> {
  const env = getEnv();
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: env.PG_BOSS_SCHEMA,
  });

  boss.on("error", (error) => {
    logger.error({ err: error }, "pg-boss error");
  });

  await boss.start();
  return boss;
}

export function getBoss(): Promise<PgBoss> {
  bossPromise ??= createBoss();
  return bossPromise;
}

export async function ensureQueue(name: string): Promise<PgBoss> {
  const boss = await getBoss();
  const existing = await boss.getQueue(name);
  if (!existing) {
    await boss.createQueue(name, {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 300,
      deleteAfterSeconds: 86400,
    });
  }
  return boss;
}

export async function enqueueJob<T extends object>(name: string, data: T): Promise<string | null> {
  const boss = await ensureQueue(name);
  return boss.send(name, data);
}

export async function enqueueUniqueJob<T extends object>(name: string, singletonKey: string, data: T): Promise<string | null> {
  const boss = await ensureQueue(name);
  return boss.send(name, data, { singletonKey });
}

export async function enqueueUniqueJobAt<T extends object>(
  name: string,
  singletonKey: string,
  data: T,
  startAfter: Date,
): Promise<string | null> {
  const boss = await ensureQueue(name);
  return boss.send(name, data, { singletonKey, startAfter });
}

export async function stopBoss(): Promise<void> {
  if (!bossPromise) return;
  const boss = await bossPromise;
  await boss.stop();
  bossPromise = null;
}
