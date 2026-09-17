import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEnv } from "@/server/env";
import * as schema from "./schema";

type DatabaseGlobal = typeof globalThis & {
  __aiCallerPool?: Pool;
};

const globalForDb = globalThis as DatabaseGlobal;

export const pool = globalForDb.__aiCallerPool ?? new Pool({
  connectionString: getEnv().DATABASE_URL,
  max: process.env.NODE_ENV === "production" ? 20 : 5,
});

if (process.env.NODE_ENV !== "production") {
  globalForDb.__aiCallerPool = pool;
}

export const db = drizzle(pool, { schema });

export async function closeDatabase() {
  await pool.end();
  if (globalForDb.__aiCallerPool === pool) {
    delete globalForDb.__aiCallerPool;
  }
}
