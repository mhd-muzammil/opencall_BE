import { env } from "../../config/env.js";
import { createGeoapifyProvider } from "./providers/geoapifyProvider.js";
import { createOlaMapsProvider } from "./providers/olaMapsProvider.js";
import { createOpenCageProvider } from "./providers/openCageProvider.js";
import type { GeocodeProvider } from "./geocodeTypes.js";

/**
 * Provider selection.
 *
 * NULL IS A FIRST-CLASS STATE, NOT AN ERROR. With no provider the
 * pincode-centroid tier still runs, so every work order with a valid PIN still
 * gets a (coarse) coordinate and the coverage telemetry still fills. That is
 * exactly the Phase 1 deployment: schema, worker and numbers in production
 * before any maps account exists or its terms have been agreed.
 */
export function resolveGeocodeProvider(): GeocodeProvider | null {
  const provider = buildProvider(env.GEOCODE_PROVIDER);

  // Naming a provider without its credentials is a misconfiguration, not a
  // choice. It is NOT fatal — the centroid tier keeps working — but it must not
  // be silent, or coverage quietly stays coarse forever and looks like a bug in
  // the geocoder rather than a missing key.
  if (!provider && env.GEOCODE_PROVIDER !== "none") {
    console.warn(
      `[geocode] GEOCODE_PROVIDER="${env.GEOCODE_PROVIDER}" is set but its credentials are missing — ` +
        "falling back to the pincode-centroid tier only.",
    );
  }

  return provider;
}

/** Every provider name this build knows how to construct. */
export const KNOWN_GEOCODE_PROVIDERS = ["ola", "geoapify", "opencage"] as const;
export type KnownGeocodeProvider = (typeof KNOWN_GEOCODE_PROVIDERS)[number];

/**
 * Every provider that has credentials configured, regardless of which one
 * `GEOCODE_PROVIDER` selects.
 *
 * This exists for the bake-off: comparing vendors requires holding several keys
 * at once, and the comparison must not depend on repeatedly flipping the setting
 * that production runs on.
 */
export function resolveAllConfiguredProviders(): GeocodeProvider[] {
  return KNOWN_GEOCODE_PROVIDERS.map(buildProvider).filter(
    (provider): provider is GeocodeProvider => provider !== null,
  );
}

function buildProvider(name: string): GeocodeProvider | null {
  switch (name) {
    case "ola":
      return env.OLA_MAPS_API_KEY ? createOlaMapsProvider(env.OLA_MAPS_API_KEY) : null;
    case "geoapify":
      return env.GEOAPIFY_API_KEY ? createGeoapifyProvider(env.GEOAPIFY_API_KEY) : null;
    case "opencage":
      return env.OPENCAGE_API_KEY ? createOpenCageProvider(env.OPENCAGE_API_KEY) : null;
    case "none":
    default:
      return null;
  }
}
