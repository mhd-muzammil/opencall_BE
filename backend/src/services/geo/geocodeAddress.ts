/**
 * Turns a Flex WIP work order into (a) a string worth sending to a geocoder and
 * (b) a stable cache key for it.
 *
 * THE CACHE KEY IS THE POINT
 * --------------------------
 * `geocode_cache` is keyed on this hash, so getting the normalization wrong
 * fails in one of two expensive directions: too strict and the same address is
 * paid for repeatedly, too loose and two different buildings share one
 * coordinate. It canonicalises case, punctuation and whitespace — and nothing
 * else. "12, Anna Salai., Chennai" and "12 Anna Salai Chennai" are one entry;
 * "12 Anna Salai" and "14 Anna Salai" are not.
 *
 * WHICH ADDRESS GETS USED
 * -----------------------
 * Whatever `addressSelector` picks. That is the whole Phase 0 payoff: the older
 * design read `Customer Address` alone and would have inherited its truncation
 * and its occasional wrong-site rows. Measured, the selector reaches 99.4%
 * usable addresses against 91.0% for Customer Address alone.
 */

import { createHash } from "node:crypto";
import {
  buildGeocodeQuery,
  selectAddress,
  type AddressCandidateFields,
  type AddressSource,
} from "./addressSelector.js";

export interface GeocodableAddress {
  /** What we send to the provider. */
  text: string;
  /** Stable hash of the canonical form — the `geocode_cache` primary key. */
  key: string;
  /** Validated 6-digit pincode, or null. Drives the centroid fallback. */
  pincode: string | null;
  /** Which Flex column the text came from. Diagnostics. */
  addressSource: AddressSource;
}

/**
 * Minimum signal worth spending a provider call on.
 *
 * A bare city + pincode has no street in it, so the provider will hand back the
 * locality centroid — which the pincode tier already gives for free. Requiring
 * some street-level text keeps paid calls for addresses that can actually beat
 * the fallback.
 */
const MIN_STREET_CHARS = 8;

/**
 * Canonical form used ONLY for the cache key, never sent to the provider.
 * Lowercase, punctuation flattened, whitespace collapsed.
 */
function canonicalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable 32-hex-char key for an address string. Exported for tests. */
export function addressKeyFor(text: string): string {
  return createHash("sha256").update(canonicalize(text)).digest("hex").slice(0, 32);
}

/**
 * Build the geocodable address for a work order, or null when there is nothing
 * worth geocoding.
 *
 * Null is not a failure — it means the pincode tier should answer alone. The
 * caller still gets a coordinate; it is just a coarse one.
 */
export function buildGeocodableAddress(
  fields: AddressCandidateFields,
): GeocodableAddress | null {
  const selected = selectAddress(fields);
  if (selected.text === null || selected.text.length < MIN_STREET_CHARS) {
    return null;
  }

  const query = buildGeocodeQuery(fields);
  if (query === null) {
    return null;
  }

  // "India" is appended unconditionally: without a country, Indian street names
  // collide with US and UK ones and providers cheerfully return another
  // continent. It is part of the key too, so the cache never mixes the two.
  const text = `${query}, India`;

  return {
    text,
    key: addressKeyFor(text),
    pincode: selected.pincode,
    addressSource: selected.source,
  };
}
