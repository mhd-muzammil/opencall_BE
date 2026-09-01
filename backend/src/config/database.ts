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

/**
 * How many connections the API may hold at once.
 *
 * This is not a throughput knob, it is the blast radius of a slow endpoint. Report
 * generation holds ONE connection for the whole of its transaction, and it is
 * regenerated on every page load and again whenever the FieldEZ worker publishes a
 * newer report (every ~15 min, which every open tab then switches onto). At a pool of
 * 10, ten staff opening the dashboard together took every connection, and
 * `connectionTimeoutMillis` then failed everything else in the app after five
 * seconds — the trivial `GET /admin/rtpl-statuses/dropdown` included, which is why a
 * slow report showed up as unrelated 500s across the whole page.
 *
 * Raising this does not make generation faster; it stops one slow endpoint from being
 * an outage for every other one. Keep it comfortably under the server's
 * `max_connections` once the workers (FieldEZ, warranty, geocoding, mail) and AdminJS
 * have taken their share — each keeps its own pool.
 */
const poolMax = Number.parseInt(process.env.PG_POOL_MAX ?? "", 10);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 20,
  idleTimeoutMillis: 30_000,
  // Deliberately short, and deliberately an ERROR rather than a wait: a request that
  // cannot get a connection should say so, not hang until the browser gives up. The
  // 500s it produces are the symptom of a starved pool, never the cause.
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
