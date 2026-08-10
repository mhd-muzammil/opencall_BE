import {
  enqueueAddresses,
  findPincodeCentroids,
  findResolvedAddresses,
  findWorkOrdersWithoutCoordinates,
  geocodeTablesPresent,
  upgradeCentroidWorkOrdersFromCache,
  upsertWorkOrderGeocode,
  type CandidateWorkOrder,
  type EnqueueAddressInput,
  type UpsertWorkOrderGeocodeInput,
} from "../../repositories/geocodeRepository.js";
import { toIndianPincode } from "./addressSelector.js";
import { buildGeocodableAddress } from "./geocodeAddress.js";

/**
 * The cascade.
 *
 * For each work order with no coordinate yet:
 *
 *   1. build a geocodable address (Phase 0's selector picks which column)
 *   2. if that address is ALREADY in the cache -> use it (free, precise)
 *   3. otherwise queue it for the worker, AND
 *   4. immediately fall back to the pincode centroid so the row has a
 *      coordinate right now
 *
 * Step 4 is the design decision worth defending. The obvious alternative —
 * leave the row blank until the provider answers — means the feature is empty
 * on day one and fills in over hours, which reads as broken to everyone who
 * looks at it. Answering coarsely now and upgrading silently later means it is
 * useful from the first sweep, and `precision` always tells the truth about
 * which tier answered.
 *
 * PHASE 1 NOTE: with no provider configured this runs the centroid tier alone.
 * That is a supported, useful state — it populates coverage telemetry and gives
 * every work order a coordinate, just a coarse one. Nothing here reads or writes
 * the Location or Distance columns; those stay on their existing pincode logic
 * until Phase 3 and Phase 4.
 */

/** Per-sweep ceiling. Keeps one sweep's DB work and provider spend bounded. */
const DEFAULT_SWEEP_LIMIT = 2_000;

export interface GeocodeSweepResult {
  available: boolean;
  /** Work orders examined this sweep. */
  examined: number;
  /** Resolved straight from the address cache. */
  fromCache: number;
  /** Given the coarse pincode centroid (pending a provider answer). */
  fromCentroid: number;
  /** Addresses newly pushed onto the worker queue. */
  enqueued: number;
  /** Upgraded from centroid to a real provider coordinate. */
  upgraded: number;
  /** Neither a usable address nor a mappable pincode. */
  unresolvable: number;
}

const EMPTY_RESULT: GeocodeSweepResult = {
  available: false,
  examined: 0,
  fromCache: 0,
  fromCentroid: 0,
  enqueued: 0,
  upgraded: 0,
  unresolvable: 0,
};

interface PreparedWorkOrder {
  candidate: CandidateWorkOrder;
  addressKey: string | null;
  addressText: string | null;
  pincode: string | null;
  addressSource: "customer" | "common" | "none";
}

/** Build the address + pincode for each candidate once, up front. */
function prepare(candidates: readonly CandidateWorkOrder[]): PreparedWorkOrder[] {
  return candidates.map((candidate) => {
    const built = buildGeocodableAddress(candidate);

    return {
      candidate,
      addressKey: built?.key ?? null,
      addressText: built?.text ?? null,
      // Fall back to the raw pincode column even when the address is too thin to
      // geocode — a work order with only a PIN still deserves its centroid.
      pincode: built?.pincode ?? toIndianPincode(candidate.customerPincode),
      addressSource: built?.addressSource ?? "none",
    };
  });
}

/**
 * Run one pass of the cascade.
 *
 * Idempotent and capped, so it is safe to call on every worker poll, from an
 * admin action, or right after an upload.
 */
export async function runGeocodeSweep(
  limit: number = DEFAULT_SWEEP_LIMIT,
): Promise<GeocodeSweepResult> {
  if (!(await geocodeTablesPresent())) {
    return EMPTY_RESULT;
  }

  // Promote anything the worker resolved since the last sweep before looking for
  // new work — cheap, and it stops the coarse tier becoming permanent.
  const upgraded = await upgradeCentroidWorkOrdersFromCache(limit);

  const candidates = await findWorkOrdersWithoutCoordinates(limit);
  if (candidates.length === 0) {
    return { ...EMPTY_RESULT, available: true, upgraded };
  }

  const prepared = prepare(candidates);

  const addressKeys = [
    ...new Set(
      prepared
        .map((item) => item.addressKey)
        .filter((key): key is string => key !== null),
    ),
  ];
  const pincodes = [
    ...new Set(
      prepared
        .map((item) => item.pincode)
        .filter((pincode): pincode is string => pincode !== null),
    ),
  ];

  const [cachedByKey, centroidByPincode] = await Promise.all([
    findResolvedAddresses(addressKeys),
    findPincodeCentroids(pincodes),
  ]);

  const toEnqueue = new Map<string, EnqueueAddressInput>();
  const toUpsert: UpsertWorkOrderGeocodeInput[] = [];
  let fromCache = 0;
  let fromCentroid = 0;
  let unresolvable = 0;

  for (const item of prepared) {
    const cached = item.addressKey ? cachedByKey.get(item.addressKey) : undefined;

    if (cached) {
      fromCache += 1;
      toUpsert.push({
        normalizedTicketId: item.candidate.normalizedTicketId,
        addressKey: cached.addressKey,
        latitude: cached.latitude,
        longitude: cached.longitude,
        precision: cached.precision,
        source: "provider",
        pincode: item.pincode,
        addressSource: item.addressSource,
      });
      continue;
    }

    // Not cached: queue the address (if we have one worth sending)...
    if (item.addressKey && item.addressText && !toEnqueue.has(item.addressKey)) {
      toEnqueue.set(item.addressKey, {
        addressKey: item.addressKey,
        addressText: item.addressText,
        pincode: item.pincode,
      });
    }

    // ...and answer now with the centroid, if the pincode has one.
    const centroid = item.pincode ? centroidByPincode.get(item.pincode) : undefined;
    if (!centroid) {
      unresolvable += 1;
      continue;
    }

    fromCentroid += 1;
    toUpsert.push({
      normalizedTicketId: item.candidate.normalizedTicketId,
      addressKey: item.addressKey,
      latitude: centroid.latitude,
      longitude: centroid.longitude,
      precision: "pincode_centroid",
      source: "pincode_centroid",
      pincode: item.pincode,
      addressSource: item.addressSource,
    });
  }

  // ORDER MATTERS: work_order_geocodes.address_key is a foreign key into
  // geocode_cache, so the queue rows must exist before the work-order rows
  // reference them. Enqueue first, always.
  const enqueued = await enqueueAddresses([...toEnqueue.values()]);

  for (const input of toUpsert) {
    await upsertWorkOrderGeocode(input);
  }

  return {
    available: true,
    examined: candidates.length,
    fromCache,
    fromCentroid,
    enqueued,
    upgraded,
    unresolvable,
  };
}
