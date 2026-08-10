/**
 * The geocoding provider boundary.
 *
 * Every provider is reduced to this one interface so the worker, the cache and
 * the tests never learn which vendor answered. That matters more than usual
 * here: Indian address quality varies enormously between providers, and the
 * only honest way to pick one is to run the same real addresses through each
 * and compare. That comparison is only cheap if swapping is a config change.
 */

/**
 * How exact a returned coordinate is.
 *
 * - `rooftop`  — the building / plot itself
 * - `street`   — the right road, not the right door
 * - `locality` — the right neighbourhood (village, area, sub-district)
 * - `none`     — the provider was asked and had no answer. TERMINAL and cached,
 *                so we never pay to ask the same question twice.
 *
 * Deliberately NOT a superset of every vendor's precision vocabulary. Each
 * adapter collapses its vendor's terms into these four, because anything finer
 * would leak vendor semantics into the schema.
 */
export type GeocodePrecision = "rooftop" | "street" | "locality" | "none";

/** Precision as stored per work order — adds the pincode-centroid fallback tier. */
export type WorkOrderPrecision = Exclude<GeocodePrecision, "none"> | "pincode_centroid";

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  precision: Exclude<GeocodePrecision, "none">;
  /** The provider's own rendering of what it matched, for eyeballing. */
  formattedAddress: string | null;
  /**
   * The provider's structured locality / sub-locality.
   *
   * This is the field that replaces the pincode's arbitrary post-office name in
   * the Location column at Phase 3. Null when the provider does not supply one —
   * which is why Phase 3 keeps the pincode tier underneath rather than assuming
   * this is always present.
   */
  locality: string | null;
}

export interface GeocodeProvider {
  /** Stable id stored on the cached row, so a bad vendor run can be requeued by name. */
  readonly name: string;

  /**
   * Hard floor on the gap between calls, in ms. The worker takes
   * `max(GEOCODE_REQUEST_SPACING_MS, this)`, so a vendor's own rate limit cannot
   * be violated by a config value tuned for a different vendor.
   *
   * This is not a nicety. OpenCage's free tier enforces 1 request/second as a
   * hard limit, while the worker's default spacing is 250ms — without this the
   * queue would spend its whole run generating 429s, and every one of those
   * costs an attempt against `GEOCODE_MAX_ATTEMPTS`.
   *
   * Omit when the vendor has no meaningful per-second limit.
   */
  readonly minRequestSpacingMs?: number;

  /**
   * Resolve one address.
   *
   * The three-way contract, and it matters:
   *  - return a `GeocodeResult` when the provider matched something
   *  - return `null` when the provider answered but found nothing — a TERMINAL,
   *    cacheable "no"
   *  - THROW on transport / quota / auth failure — the item stays retryable
   *
   * Conflating the last two is the classic bug in this kind of worker: a 429
   * swallowed as `null` permanently caches "this address does not exist". Ola
   * returns HTTP 429 for both per-minute and monthly limits, so its adapter has
   * to get this right on the very first quota bump.
   */
  geocode(address: string, signal: AbortSignal): Promise<GeocodeResult | null>;
}

/** Thrown for provider failures. `retryable` distinguishes a blip from a bad request. */
export class GeocodeProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "GeocodeProviderError";
  }
}
