import {
  GeocodeProviderError,
  type GeocodePrecision,
  type GeocodeProvider,
  type GeocodeResult,
} from "../geocodeTypes.js";

/**
 * Geoapify forward geocoding.
 *
 * Chosen alongside OpenCage because its terms EXPLICITLY permit storing and
 * reusing results in your own database — which is what `geocode_cache` is. That
 * closes the retention question Ola left open, so `GEOCODE_CACHE_TTL_DAYS` can
 * stay at 0 (never expire) rather than being a hedge.
 *
 * The honest caveat: Geoapify is OpenStreetMap-derived, and OSM's semi-urban
 * Tamil Nadu coverage is thinner than the proprietary Indian datasets. Salem,
 * Hosur and Vellore are where that will show, and they are 3 of 5 branches. The
 * bake-off reports hit rate PER BRANCH for exactly this reason — a provider that
 * is fine in Chennai and useless in Hosur must not pass on an average.
 */

const GEOAPIFY_GEOCODE_URL = "https://api.geoapify.com/v1/geocode/search";

interface GeoapifyRank {
  confidence?: number;
  match_type?: string;
}

interface GeoapifyProperties {
  lat?: number;
  lon?: number;
  formatted?: string;
  result_type?: string;
  rank?: GeoapifyRank;
  name?: string;
  housenumber?: string;
  street?: string;
  suburb?: string;
  district?: string;
  city?: string;
  county?: string;
  state?: string;
  postcode?: string;
}

interface GeoapifyResponse {
  features?: { properties?: GeoapifyProperties }[];
  /** Error payloads come back with a message rather than features. */
  message?: string;
  error?: string;
}

/**
 * Collapse Geoapify's `result_type` into our four-value vocabulary.
 *
 * `amenity` and `building` are both plot-level. Everything administrative —
 * postcode, city, district — is `locality`, and anything unrecognised falls
 * there too: the pessimistic choice, so an unknown label is never mistaken for
 * a doorstep.
 */
function toPrecision(properties: GeoapifyProperties): Exclude<GeocodePrecision, "none"> {
  switch ((properties.result_type ?? "").toLowerCase()) {
    case "building":
    case "amenity":
      return "rooftop";
    case "street":
      return "street";
    default:
      // A result typed as something coarse but carrying a house number is still
      // a doorstep — Geoapify types some Indian plot addresses this way.
      if (properties.housenumber && properties.street) {
        return "rooftop";
      }
      return "locality";
  }
}

/**
 * The area name for the Location column, most specific first.
 *
 * A suburb ("Anna Nagar West") beats a district beats a city. This is the field
 * that replaces the pincode's arbitrary post-office name, so it is worth reading
 * in priority order rather than taking whatever is first.
 */
function extractLocality(properties: GeoapifyProperties): string | null {
  const candidates = [
    properties.suburb,
    properties.district,
    properties.city,
    properties.county,
  ];

  for (const candidate of candidates) {
    const name = candidate?.trim();
    if (name) {
      return name;
    }
  }

  return null;
}

export function createGeoapifyProvider(apiKey: string): GeocodeProvider {
  return {
    name: "geoapify",
    async geocode(address, signal) {
      const url = new URL(GEOAPIFY_GEOCODE_URL);
      url.searchParams.set("text", address);
      // Hard country filter: without it an Indian street name can match a US or
      // UK one and the result looks perfectly plausible.
      url.searchParams.set("filter", "countrycode:in");
      url.searchParams.set("limit", "1");
      url.searchParams.set("format", "geojson");
      url.searchParams.set("apiKey", apiKey);

      let response: Response;
      try {
        response = await fetch(url, { signal, headers: { Accept: "application/json" } });
      } catch (error) {
        // Network-level failure, including an aborted request — always retryable.
        throw new GeocodeProviderError(
          `geoapify: request failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 429 must NEVER become a cached "not found": that would permanently
      // record "this address does not exist" for every address in flight when
      // the daily allowance ran out.
      if (response.status === 429 || response.status >= 500) {
        throw new GeocodeProviderError(`geoapify: HTTP ${response.status}`, true);
      }
      // Other 4xx means the REQUEST is wrong (bad key, bad params). Retrying
      // forever would spin the queue, so fail loudly and non-retryably.
      if (!response.ok) {
        throw new GeocodeProviderError(`geoapify: HTTP ${response.status}`, false);
      }

      let body: GeoapifyResponse;
      try {
        body = (await response.json()) as GeoapifyResponse;
      } catch (error) {
        throw new GeocodeProviderError(
          `geoapify: unreadable response — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // An error described in the body of a 200. Treating this as "no match" is
      // the exact bug the provider contract warns about.
      if (body.error ?? (body.message && !body.features)) {
        throw new GeocodeProviderError(
          `geoapify: ${body.error ?? body.message}`,
          true,
        );
      }

      const properties = body.features?.[0]?.properties;
      const lat = properties?.lat;
      const lon = properties?.lon;

      // Answered, found nothing — terminal, cacheable "no".
      if (!properties || typeof lat !== "number" || typeof lon !== "number") {
        return null;
      }

      const result: GeocodeResult = {
        latitude: lat,
        longitude: lon,
        precision: toPrecision(properties),
        formattedAddress: properties.formatted ?? null,
        locality: extractLocality(properties),
      };
      return result;
    },
  };
}
