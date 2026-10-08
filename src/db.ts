import { Pool, PoolClient, types } from "pg";
import { config } from "./config";

// Return DATE columns as plain "YYYY-MM-DD" text (no timezone surprises).
types.setTypeParser(1082, (v) => v);
// NUMERIC stays as text on purpose, so money never becomes a float.

export const pool = new Pool({ connectionString: config.DATABASE_URL });

export type Queryable = Pick<Pool, "query">;

/** Run work inside one transaction. Rolls back if anything throws. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
