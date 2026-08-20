import pg from "pg";
import { env } from "./env.js";

/**
 * Server-side session settings, verbatim, for processes that want a query to fail rather
 * than wait for ever — `-c lock_timeout=15s -c statement_timeout=120s`, say.
 *
 * `connectionTimeoutMillis` below bounds only the wait for a free connection; once a query
 * is running, node-postgres will wait on it indefinitely. A query blocked behind a lock
 * therefore produces no error, no log line and no progress — a process that looks alive and
 * is doing nothing, which is exactly how the mail worker presented.
 *
 * Unset by default, so the API keeps its current unbounded behaviour and its long report
 * queries are untouched. Only a process whose environment asks for a ceiling gets one.
 */
const sessionOptions = process.env.PG_SESSION_OPTIONS?.trim();

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ...(sessionOptions ? { options: sessionOptions } : {}),
});

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, [...params]);
}

export async function closeDatabasePool(): Promise<void> {
  await pool.end();
}

export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
