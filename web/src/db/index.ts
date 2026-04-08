import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import * as relations from "./relations";

const globalForDb = globalThis as unknown as { pool: Pool };

const pool =
  globalForDb.pool ||
  new Pool({ connectionString: process.env.DATABASE_URL! });

if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;

export const db = drizzle(pool, { schema: { ...schema, ...relations } });
