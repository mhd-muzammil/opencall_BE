import {
  GeocodeProviderError,
  type GeocodePrecision,
  type GeocodeProvider,
  type GeocodeResult,
} from "../geocodeTypes.js";

/**
 * Ola Maps (Krutrim) forward geocoding.
 *
 * Chosen because its published free allowance — 500,000 requests/month across
 * all Ola Maps APIs, no credit card, first year free — comfortably exceeds
 * OpenCall's entire volume. Measured against production history there are 2,803
 * distinct addresses to geocode in the whole backfill, which is 0.6% of one
 * month's allowance, and steady-state volume is a small fraction of that.
 *
 * Verify the allowance and the data-retention clause before relying on either;
 * vendor terms move. `GEOCODE_CACHE_TTL_DAYS` exists precisely because the
 * retention clause could not be confirmed when this was written.
 */

const OLA_GEOCODE_URL = "https://api.olamaps.io/places/v1/geocode";

interface OlaAddressComponent {
  long_name?: string;
  short_name?: string;
  types?: string[];
}

interface OlaGeocodeHit {
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  /** e.g. "rooftop" | "approximate" | "geometric_center" | "range_interpolated" */
  location_type?: string;
  address_components?: OlaAddressComponent[];
  types?: string[];
}

interface OlaGeocodeResponse {
  geocodingResults?: OlaGeocodeHit[];
  /** Some error shapes carry a status/message rather than an HTTP error code. */
  status?: string;
  message?: string;
}

/**
 * Collapse the vendor's `location_type` into our four-value vocabulary.
 *
 * Unknown values fall to `locality` — the pessimistic choice, so an unrecognised
 * label is treated as a wide circle rather than a false doorstep.
 */
function toPrecision(locationType: string | undefined): Exclude<GeocodePrecision, "none"> {
  switch ((locationType ?? "").toLowerCase()) {
    case "rooftop":
      return "rooftop";
    case "range_interpolated":
    case "geometric_center":
      return "street";
    default:
      return "locality";
  }
}

/**
 * The area name for the Location column.
 *
 * Ordered most specific first: a sublocality ("Anna Nagar West") beats a
 * locality ("Anna Nagar") beats a district. This is the field that replaces the
 * pincode's arbitrary post-office name — the whole reason Phase 3 is worth doing
 * — so it is worth reading carefully rather than taking component[0].
 */
const LOCALITY_TYPES_BY_PRIORITY = [
  "sublocality_level_1",
  "sublocality",
  "neighborhood",
  "locality",
  "administrative_area_level_3",
  "administrative_area_level_2",
] as const;

function extractLocality(hit: OlaGeocodeHit): string | null {
  const components = hit.address_components ?? [];

  for (const wanted of LOCALITY_TYPES_BY_PRIORITY) {
    const match = components.find((component) => component.types?.includes(wanted));
    const name = match?.long_name?.trim();
    if (name) {
      return name;
    }
  }

  return null;
}

export function createOlaMapsProvider(apiKey: string): GeocodeProvider {
  return {
    name: "ola",
    async geocode(address, signal) {
      const url = new URL(OLA_GEOCODE_URL);
      url.searchParams.set("address", address);
      url.searchParams.set("language", "English");
      url.searchParams.set("api_key", apiKey);

      let response: Response;
      try {
        response = await fetch(url, { signal, headers: { Accept: "application/json" } });
      } catch (error) {
        // Network-level failure, including an aborted request — always retryable.
        throw new GeocodeProviderError(
          `ola: request failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 429 is the one that must never be swallowed as "not found": Ola returns
      // it for BOTH the per-minute and the monthly limit, so mis-handling it
      // would permanently cache "this address does not exist" for every address
      // in flight when the tier was exhausted.
      if (response.status === 429 || response.status >= 500) {
        throw new GeocodeProviderError(`ola: HTTP ${response.status}`, true);
      }
      // Other 4xx means the REQUEST is wrong (bad key, bad params). Retrying
      // forever would just spin the queue, so fail loudly and non-retryably.
      if (!response.ok) {
        throw new GeocodeProviderError(`ola: HTTP ${response.status}`, false);
      }

      let body: OlaGeocodeResponse;
      try {
        body = (await response.json()) as OlaGeocodeResponse;
      } catch (error) {
        throw new GeocodeProviderError(
          `ola: unreadable response — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // A quota or auth failure signalled in the BODY with HTTP 200. Treating
      // this as "no match" is the exact bug the provider contract warns about.
      const status = body.status?.toLowerCase();
      if (status && status !== "ok" && status !== "zero_results") {
        const retryable = status.includes("limit") || status.includes("quota");
        throw new GeocodeProviderError(
          `ola: ${body.status}${body.message ? ` — ${body.message}` : ""}`,
          retryable,
        );
      }

      const hit = body.geocodingResults?.[0];
      const lat = hit?.geometry?.location?.lat;
      const lng = hit?.geometry?.location?.lng;

      // Answered, found nothing — terminal, cacheable "no".
      if (!hit || typeof lat !== "number" || typeof lng !== "number") {
        return null;
      }

      const result: GeocodeResult = {
        latitude: lat,
        longitude: lng,
        precision: toPrecision(hit.location_type),
        formattedAddress: hit.formatted_address ?? null,
        locality: extractLocality(hit),
      };
      return result;
    },
  };
}
