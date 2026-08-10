import {
  GeocodeProviderError,
  type GeocodePrecision,
  type GeocodeProvider,
  type GeocodeResult,
} from "../geocodeTypes.js";

/**
 * OpenCage forward geocoding.
 *
 * Chosen alongside Geoapify because permission to CACHE results is OpenCage's
 * stated difference from Google — which is precisely what `geocode_cache`
 * depends on. Free tier is 2,500 requests/day, comfortably above the 2,772
 * one-time backfill spread over two days, and far above steady state.
 *
 * TWO VENDOR QUIRKS THIS ADAPTER EXISTS TO HANDLE
 * -----------------------------------------------
 * 1. The free tier enforces 1 request/second as a HARD limit, well below the
 *    worker's 250ms default. `minRequestSpacingMs` below is what stops the run
 *    turning into a 429 storm that burns every address's attempt budget.
 *
 * 2. Quota exhaustion is HTTP 402, not 429. A reader who only special-cases 429
 *    would classify 402 as "bad request", mark it non-retryable, and fail every
 *    queued address the moment the daily allowance ran out — permanently, since
 *    nothing would requeue them.
 */

const OPENCAGE_GEOCODE_URL = "https://api.opencagedata.com/geocode/v1/json";

interface OpenCageComponents {
  _type?: string;
  suburb?: string;
  neighbourhood?: string;
  city_district?: string;
  village?: string;
  town?: string;
  city?: string;
  county?: string;
  state?: string;
  postcode?: string;
  road?: string;
  house_number?: string;
}

interface OpenCageResult {
  geometry?: { lat?: number; lng?: number };
  formatted?: string;
  components?: OpenCageComponents;
  /** 0-10; reflects the size of the matched bounding box, not rooftop-ness. */
  confidence?: number;
}

interface OpenCageResponse {
  results?: OpenCageResult[];
  status?: { code?: number; message?: string };
}

/**
 * Collapse OpenCage's result into our four-value vocabulary.
 *
 * Driven by `components._type` and the presence of a house number rather than by
 * `confidence`: confidence describes how SMALL the matched bounding box is, not
 * how precisely the address was matched, so a tight box around the wrong village
 * scores well. The component shape is the honest signal.
 */
function toPrecision(result: OpenCageResult): Exclude<GeocodePrecision, "none"> {
  const components = result.components ?? {};

  if (components.house_number && components.road) {
    return "rooftop";
  }

  switch ((components._type ?? "").toLowerCase()) {
    case "building":
    case "address":
      return "rooftop";
    case "road":
      return "street";
    default:
      return "locality";
  }
}

/**
 * The area name for the Location column, most specific first.
 *
 * Village and town come before city because in Tamil Nadu's semi-urban belt the
 * `city` field is often the district headquarters rather than where the engineer
 * is actually going.
 */
function extractLocality(result: OpenCageResult): string | null {
  const components = result.components ?? {};
  const candidates = [
    components.suburb,
    components.neighbourhood,
    components.city_district,
    components.village,
    components.town,
    components.city,
    components.county,
  ];

  for (const candidate of candidates) {
    const name = candidate?.trim();
    if (name) {
      return name;
    }
  }

  return null;
}

export function createOpenCageProvider(apiKey: string): GeocodeProvider {
  return {
    name: "opencage",
    // The free tier's hard 1 req/sec limit. See the file header.
    minRequestSpacingMs: 1_100,
    async geocode(address, signal) {
      const url = new URL(OPENCAGE_GEOCODE_URL);
      url.searchParams.set("q", address);
      // Hard country filter: an Indian street name can otherwise match a US or
      // UK one and the result looks entirely plausible.
      url.searchParams.set("countrycode", "in");
      url.searchParams.set("limit", "1");
      url.searchParams.set("no_annotations", "1");
      url.searchParams.set("key", apiKey);

      let response: Response;
      try {
        response = await fetch(url, { signal, headers: { Accept: "application/json" } });
      } catch (error) {
        throw new GeocodeProviderError(
          `opencage: request failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 402 is QUOTA EXCEEDED — retryable tomorrow, and absolutely not a "no
      // match". 429 is the per-second limit. Both must leave the address queued.
      if (response.status === 402 || response.status === 429 || response.status >= 500) {
        throw new GeocodeProviderError(`opencage: HTTP ${response.status}`, true);
      }
      if (!response.ok) {
        throw new GeocodeProviderError(`opencage: HTTP ${response.status}`, false);
      }

      let body: OpenCageResponse;
      try {
        body = (await response.json()) as OpenCageResponse;
      } catch (error) {
        throw new GeocodeProviderError(
          `opencage: unreadable response — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // The same codes can arrive inside a 200 body. Same classification.
      const statusCode = body.status?.code;
      if (statusCode === 402 || statusCode === 429 || (statusCode && statusCode >= 500)) {
        throw new GeocodeProviderError(
          `opencage: status ${statusCode}${body.status?.message ? ` — ${body.status.message}` : ""}`,
          true,
        );
      }

      const hit = body.results?.[0];
      const lat = hit?.geometry?.lat;
      const lng = hit?.geometry?.lng;

      // Answered, found nothing — terminal, cacheable "no".
      if (!hit || typeof lat !== "number" || typeof lng !== "number") {
        return null;
      }

      const result: GeocodeResult = {
        latitude: lat,
        longitude: lng,
        precision: toPrecision(hit),
        formattedAddress: hit.formatted ?? null,
        locality: extractLocality(hit),
      };
      return result;
    },
  };
}
