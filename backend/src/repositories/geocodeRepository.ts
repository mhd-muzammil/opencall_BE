import { query } from "../config/database.js";
import type {
  GeocodePrecision,
  WorkOrderPrecision,
} from "../services/geo/geocodeTypes.js";
import type { AddressSource } from "../services/geo/addressSelector.js";

/**
 * Persistence for the geocoding cascade.
 *
 * `geocode_cache` is both the permanent address cache AND the worker queue (see
 * migration 045) — the same shape as `warranty_job_items`, claimed with
 * `FOR UPDATE SKIP LOCKED` so several workers can drain it without ever handing
 * the same address to two of them.
 *
 * `work_order_geocodes` is keyed on the normalized TICKET id, matching how every
 * consumer joins. See the migration header for why case id was rejected.
 */

export interface GeocodeQueueItem {
  addressKey: string;
  addressText: string;
  pincode: string | null;
  attempts: number;
}

interface GeocodeQueueRow {
  address_key: string;
  address_text: string;
  pincode: string | null;
  attempts: number;
}

/**
 * True when every table the cascade reads exists. Lets callers degrade instead
 * of throwing.
 *
 * `pincode_geo` belongs to migration 043, not 045, and is checked here for a
 * concrete reason: the centroid tier reads it, so a box with 045 applied but 043
 * missing would have the sweep die on "relation does not exist" rather than
 * quietly do nothing. That is the same failure shape as the 2026-08-06 outage,
 * where a missing column 500'd three pages while /health/runtime still reported
 * ready. Ordering in migrationOrder.ts makes the gap unlikely; this makes it
 * harmless.
 */
export async function geocodeTablesPresent(): Promise<boolean> {
  const result = await query<{ present: boolean }>(
    `
      SELECT COUNT(*) = 3 AS present
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('geocode_cache', 'work_order_geocodes', 'pincode_geo')
    `,
  );
  return result.rows[0]?.present ?? false;
}

export interface EnqueueAddressInput {
  addressKey: string;
  addressText: string;
  pincode: string | null;
}

/**
 * Add addresses to the queue, skipping any already known.
 *
 * `DO NOTHING` is what makes the enqueue path idempotent: a resolved address is
 * never re-queued, a failed one is left for the retry sweep to decide about, and
 * re-running the sweep every 15 minutes costs nothing. Returns how many rows
 * were genuinely new.
 */
export async function enqueueAddresses(
  inputs: readonly EnqueueAddressInput[],
): Promise<number> {
  if (inputs.length === 0) {
    return 0;
  }

  const params: unknown[] = [];
  const tuples = inputs.map((input, index) => {
    const offset = index * 3;
    params.push(input.addressKey, input.addressText, input.pincode);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
  });

  const result = await query(
    `
      INSERT INTO geocode_cache (address_key, address_text, pincode)
      VALUES ${tuples.join(", ")}
      ON CONFLICT (address_key) DO NOTHING
    `,
    params,
  );

  return result.rowCount ?? 0;
}

/** Atomically claim the oldest pending address. */
export async function claimNextPendingAddress(): Promise<GeocodeQueueItem | null> {
  const result = await query<GeocodeQueueRow>(
    `
      UPDATE geocode_cache
         SET state = 'processing',
             locked_at = NOW(),
             attempts = attempts + 1,
             updated_at = NOW()
       WHERE address_key = (
         SELECT address_key
           FROM geocode_cache
          WHERE state = 'pending'
          ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
      RETURNING address_key, address_text, pincode, attempts
    `,
  );

  const row = result.rows[0];
  return row
    ? {
        addressKey: row.address_key,
        addressText: row.address_text,
        pincode: row.pincode,
        attempts: Number(row.attempts),
      }
    : null;
}

export interface ResolveAddressInput {
  addressKey: string;
  latitude: number | null;
  longitude: number | null;
  precision: GeocodePrecision;
  provider: string;
  formattedAddress: string | null;
  locality: string | null;
}

/**
 * Mark an address resolved. `precision: 'none'` with null coordinates is a valid
 * terminal state meaning "the provider was asked and had no answer" — cached so
 * we never pay to ask again.
 */
export async function markAddressResolved(input: ResolveAddressInput): Promise<void> {
  await query(
    `
      UPDATE geocode_cache
         SET state = 'done',
             latitude = $2,
             longitude = $3,
             precision = $4,
             provider = $5,
             formatted_address = $6,
             locality = $7,
             last_error = NULL,
             locked_at = NULL,
             resolved_at = NOW(),
             updated_at = NOW()
       WHERE address_key = $1
    `,
    [
      input.addressKey,
      input.latitude,
      input.longitude,
      input.precision,
      input.provider,
      input.formattedAddress,
      input.locality,
    ],
  );
}

export async function markAddressFailed(
  addressKey: string,
  lastError: string,
): Promise<void> {
  await query(
    `
      UPDATE geocode_cache
         SET state = 'failed',
             locked_at = NULL,
             last_error = $2,
             updated_at = NOW()
       WHERE address_key = $1
    `,
    [addressKey, lastError],
  );
}

export interface ReclaimResult {
  requeued: number;
  exhausted: number;
}

/**
 * Recover addresses abandoned in `processing` by a worker that died mid-item.
 *
 * Without this they are stranded forever, because `claimNextPendingAddress` only
 * takes `pending`. An address that has already burned `maxAttempts` is failed
 * rather than requeued, so one address that reliably crashes the adapter cannot
 * spin the worker indefinitely.
 */
export async function reclaimStaleProcessingAddresses(
  staleAfterSeconds: number,
  maxAttempts: number,
): Promise<ReclaimResult> {
  const exhausted = await query(
    `
      UPDATE geocode_cache
         SET state = 'failed',
             locked_at = NULL,
             last_error = 'Worker died while geocoding (stale lock); attempt limit reached',
             updated_at = NOW()
       WHERE state = 'processing'
         AND locked_at IS NOT NULL
         AND locked_at < NOW() - ($1 * INTERVAL '1 second')
         AND attempts >= $2
    `,
    [staleAfterSeconds, maxAttempts],
  );

  const requeued = await query(
    `
      UPDATE geocode_cache
         SET state = 'pending',
             locked_at = NULL,
             last_error = 'Worker died while geocoding (stale lock); requeued',
             updated_at = NOW()
       WHERE state = 'processing'
         AND locked_at IS NOT NULL
         AND locked_at < NOW() - ($1 * INTERVAL '1 second')
         AND attempts < $2
    `,
    [staleAfterSeconds, maxAttempts],
  );

  return {
    requeued: requeued.rowCount ?? 0,
    exhausted: exhausted.rowCount ?? 0,
  };
}

/**
 * Requeue failed addresses that have not exhausted their attempts.
 *
 * A provider outage fails a burst of addresses; without this they would sit in
 * `failed` forever and those work orders would stay on the coarse tier even
 * after the provider recovered.
 */
export async function retryFailedAddresses(maxAttempts: number): Promise<number> {
  const result = await query(
    `
      UPDATE geocode_cache
         SET state = 'pending',
             locked_at = NULL,
             updated_at = NOW()
       WHERE state = 'failed'
         AND attempts < $1
    `,
    [maxAttempts],
  );
  return result.rowCount ?? 0;
}

/**
 * Expire cached answers older than the TTL by pushing them back to 'pending'.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Some map vendors cap how long a geocoding result may be stored (Google's terms
 * say 30 days). Ola's terms could not be verified before this was written, so
 * the capability is built now and defaulted OFF — `ttlDays <= 0` means "never
 * expire", which is the behaviour when no such clause applies.
 *
 * Cost of turning it on is negligible: re-geocoding every distinct address once
 * a month is a few thousand calls against a 500,000/month free tier. Retrofitting
 * it later would not have been.
 *
 * `attempts` is reset so an expired-then-requeued address is not mistaken for a
 * flaky one and failed early by the attempt cap.
 */
export async function expireStaleCacheEntries(ttlDays: number): Promise<number> {
  if (ttlDays <= 0) {
    return 0;
  }

  const result = await query(
    `
      UPDATE geocode_cache
         SET state = 'pending',
             attempts = 0,
             locked_at = NULL,
             updated_at = NOW()
       WHERE state = 'done'
         AND resolved_at IS NOT NULL
         AND resolved_at < NOW() - ($1 * INTERVAL '1 day')
    `,
    [ttlDays],
  );
  return result.rowCount ?? 0;
}

export interface CandidateWorkOrder {
  normalizedTicketId: string;
  customerAddress: string | null;
  commonAddress: string | null;
  customerCity: string | null;
  customerState: string | null;
  customerPincode: string | null;
}

interface CandidateWorkOrderRow {
  normalized_ticket_id: string;
  customer_address: string | null;
  common_address: string | null;
  customer_city: string | null;
  customer_state: string | null;
  customer_pincode: string | null;
}

/**
 * Work orders that have no coordinate yet.
 *
 * Reads the real address columns added by migration 044, falling back to
 * `raw_row` for any row written between that deploy and its backfill. DISTINCT
 * ON keeps the newest row per ticket, since the same ticket reappears in every
 * upload — 40,640 rows collapse to 3,242 tickets.
 */
export async function findWorkOrdersWithoutCoordinates(
  limit: number,
): Promise<CandidateWorkOrder[]> {
  const result = await query<CandidateWorkOrderRow>(
    `
      SELECT DISTINCT ON (fw.normalized_ticket_id)
             fw.normalized_ticket_id,
             COALESCE(fw.customer_address, fw.raw_row->>'Customer Address') AS customer_address,
             COALESCE(fw.common_address,   fw.raw_row->>'Common Address')   AS common_address,
             COALESCE(fw.customer_city,    fw.raw_row->>'Customer City')    AS customer_city,
             COALESCE(fw.customer_state,   fw.raw_row->>'Customer State')   AS customer_state,
             COALESCE(fw.customer_pincode, fw.raw_row->>'Customer Pincode') AS customer_pincode
        FROM flex_wip_records fw
        LEFT JOIN work_order_geocodes g
               ON g.normalized_ticket_id = fw.normalized_ticket_id
       WHERE fw.normalized_ticket_id IS NOT NULL
         AND fw.normalized_ticket_id <> ''
         AND g.normalized_ticket_id IS NULL
       ORDER BY fw.normalized_ticket_id, fw.created_at DESC
       LIMIT $1
    `,
    [limit],
  );

  return result.rows.map((row) => ({
    normalizedTicketId: row.normalized_ticket_id,
    customerAddress: row.customer_address,
    commonAddress: row.common_address,
    customerCity: row.customer_city,
    customerState: row.customer_state,
    customerPincode: row.customer_pincode,
  }));
}

export interface UpsertWorkOrderGeocodeInput {
  normalizedTicketId: string;
  addressKey: string | null;
  latitude: number;
  longitude: number;
  precision: WorkOrderPrecision;
  source: "provider" | "pincode_centroid";
  pincode: string | null;
  addressSource: AddressSource;
}

/**
 * Write a work order's resolved coordinate.
 *
 * The `WHERE` clause is the load-bearing part: an existing PROVIDER answer is
 * never overwritten by a pincode centroid. Without it, a re-run of the sweep
 * would happily downgrade good rooftop coordinates to 2 km circles.
 */
export async function upsertWorkOrderGeocode(
  input: UpsertWorkOrderGeocodeInput,
): Promise<void> {
  await query(
    `
      INSERT INTO work_order_geocodes (
        normalized_ticket_id, address_key, latitude, longitude,
        precision, source, pincode, address_source
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (normalized_ticket_id) DO UPDATE
        SET address_key    = EXCLUDED.address_key,
            latitude       = EXCLUDED.latitude,
            longitude      = EXCLUDED.longitude,
            precision      = EXCLUDED.precision,
            source         = EXCLUDED.source,
            pincode        = EXCLUDED.pincode,
            address_source = EXCLUDED.address_source,
            resolved_at    = NOW()
      WHERE work_order_geocodes.source = 'pincode_centroid'
         OR EXCLUDED.source = 'provider'
    `,
    [
      input.normalizedTicketId,
      input.addressKey,
      input.latitude,
      input.longitude,
      input.precision,
      input.source,
      input.pincode,
      input.addressSource,
    ],
  );
}

/**
 * Promote work orders sitting on a pincode centroid whose address has since been
 * geocoded properly.
 *
 * This closes the loop between the two halves of the pipeline. A work order gets
 * the centroid IMMEDIATELY so nothing is ever blank, and its address is queued at
 * the same time; when the worker later resolves that address, nothing would
 * otherwise notice — `findWorkOrdersWithoutCoordinates` skips the ticket because
 * it now has a row. Without this pass every work order would be permanently
 * stuck on the coarse tier and the provider calls would be wasted.
 *
 * @returns how many work orders were upgraded.
 */
export async function upgradeCentroidWorkOrdersFromCache(limit: number): Promise<number> {
  const result = await query(
    `
      UPDATE work_order_geocodes wg
         SET latitude    = up.latitude,
             longitude   = up.longitude,
             precision   = up.precision,
             source      = 'provider',
             resolved_at = NOW()
        FROM (
          SELECT w.normalized_ticket_id, g.latitude, g.longitude, g.precision
            FROM work_order_geocodes w
            JOIN geocode_cache g ON g.address_key = w.address_key
           WHERE w.source = 'pincode_centroid'
             AND g.state = 'done'
             AND g.precision <> 'none'
             AND g.latitude IS NOT NULL
             AND g.longitude IS NOT NULL
           LIMIT $1
        ) AS up
       WHERE wg.normalized_ticket_id = up.normalized_ticket_id
    `,
    [limit],
  );
  return result.rowCount ?? 0;
}

export interface ResolvedAddress {
  addressKey: string;
  latitude: number;
  longitude: number;
  precision: Exclude<GeocodePrecision, "none">;
}

/** Already-resolved addresses (cache hits), keyed by address key. */
export async function findResolvedAddresses(
  addressKeys: readonly string[],
): Promise<Map<string, ResolvedAddress>> {
  if (addressKeys.length === 0) {
    return new Map();
  }

  const result = await query<{
    address_key: string;
    latitude: number;
    longitude: number;
    precision: Exclude<GeocodePrecision, "none">;
  }>(
    `
      SELECT address_key, latitude, longitude, precision
      FROM geocode_cache
      WHERE address_key = ANY($1::text[])
        AND state = 'done'
        AND precision <> 'none'
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
    `,
    [[...addressKeys]],
  );

  return new Map(
    result.rows.map((row) => [
      row.address_key,
      {
        addressKey: row.address_key,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        precision: row.precision,
      },
    ]),
  );
}

export interface PincodeCentroid {
  latitude: number;
  longitude: number;
}

/**
 * Pincode centroids for the fallback tier.
 *
 * Reads `pincode_geo` — migration 043's table, populated through an estimator
 * that survives the All India Pincode Directory's corrupt coordinates (a
 * longitude typed 70 instead of 80 put one Kolathur call at 539 km). Hand
 * corrections there carry source='manual' and are never overwritten by an
 * import, so this lookup inherits that protection for free.
 */
export async function findPincodeCentroids(
  pincodes: readonly string[],
): Promise<Map<string, PincodeCentroid>> {
  if (pincodes.length === 0) {
    return new Map();
  }

  const result = await query<{
    pincode: string;
    latitude: string;
    longitude: string;
  }>(
    `
      SELECT pincode, latitude, longitude
      FROM pincode_geo
      WHERE pincode = ANY($1::text[])
    `,
    [[...pincodes]],
  );

  return new Map(
    result.rows.map((row) => [
      row.pincode,
      // NUMERIC comes back as a string from pg; Number() here rather than at
      // every call site.
      { latitude: Number(row.latitude), longitude: Number(row.longitude) },
    ]),
  );
}

export interface GeocodeCoverage {
  workOrdersTotal: number;
  workOrdersWithCoordinate: number;
  rooftop: number;
  street: number;
  locality: number;
  pincodeCentroid: number;
  queuePending: number;
  queueProcessing: number;
  queueDone: number;
  queueFailed: number;
  queueNoMatch: number;
}

/**
 * Coverage telemetry.
 *
 * This exists because the pincode mapping it replaces had NO miss-rate
 * visibility — an unmapped pincode just printed as digits and nobody knew.
 * Coverage has to be a number somebody can look at, or this feature rots the
 * same way.
 */
export async function getGeocodeCoverage(): Promise<GeocodeCoverage> {
  const result = await query<Record<string, string>>(
    `
      SELECT
        (SELECT COUNT(DISTINCT normalized_ticket_id)
           FROM flex_wip_records
          WHERE normalized_ticket_id IS NOT NULL AND normalized_ticket_id <> '') AS work_orders_total,
        (SELECT COUNT(*) FROM work_order_geocodes) AS work_orders_with_coordinate,
        (SELECT COUNT(*) FROM work_order_geocodes WHERE precision = 'rooftop') AS rooftop,
        (SELECT COUNT(*) FROM work_order_geocodes WHERE precision = 'street') AS street,
        (SELECT COUNT(*) FROM work_order_geocodes WHERE precision = 'locality') AS locality,
        (SELECT COUNT(*) FROM work_order_geocodes WHERE precision = 'pincode_centroid') AS pincode_centroid,
        (SELECT COUNT(*) FROM geocode_cache WHERE state = 'pending') AS queue_pending,
        (SELECT COUNT(*) FROM geocode_cache WHERE state = 'processing') AS queue_processing,
        (SELECT COUNT(*) FROM geocode_cache WHERE state = 'done') AS queue_done,
        (SELECT COUNT(*) FROM geocode_cache WHERE state = 'failed') AS queue_failed,
        (SELECT COUNT(*) FROM geocode_cache WHERE state = 'done' AND precision = 'none') AS queue_no_match
    `,
  );

  const row = result.rows[0];
  const num = (key: string): number => Number(row?.[key] ?? 0);

  return {
    workOrdersTotal: num("work_orders_total"),
    workOrdersWithCoordinate: num("work_orders_with_coordinate"),
    rooftop: num("rooftop"),
    street: num("street"),
    locality: num("locality"),
    pincodeCentroid: num("pincode_centroid"),
    queuePending: num("queue_pending"),
    queueProcessing: num("queue_processing"),
    queueDone: num("queue_done"),
    queueFailed: num("queue_failed"),
    queueNoMatch: num("queue_no_match"),
  };
}
