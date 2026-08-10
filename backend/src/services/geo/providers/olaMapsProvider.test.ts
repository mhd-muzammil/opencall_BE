import { afterEach, describe, expect, it, vi } from "vitest";
import { createOlaMapsProvider } from "./olaMapsProvider.js";
import { GeocodeProviderError } from "../geocodeTypes.js";

/**
 * These tests exist for one reason: the difference between "the provider
 * answered and found nothing" (cache it forever) and "the provider could not
 * answer" (retry it) is the difference between a working cache and one that
 * permanently records "this address does not exist" for every address in flight
 * when the monthly quota ran out.
 *
 * Ola returns HTTP 429 for BOTH the per-minute and the monthly limit, so this
 * is not a hypothetical edge case — it is what happens the first time the free
 * tier is exhausted.
 */

const provider = createOlaMapsProvider("test-key");
const signal = new AbortController().signal;

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("olaMapsProvider", () => {
  it("returns a result with coordinates and precision", async () => {
    mockFetch(200, {
      geocodingResults: [
        {
          formatted_address: "12 Anna Salai, Chennai, Tamil Nadu 600002, India",
          geometry: { location: { lat: 13.0604, lng: 80.2496 } },
          location_type: "rooftop",
          address_components: [
            { long_name: "Anna Nagar West", types: ["sublocality_level_1"] },
            { long_name: "Chennai", types: ["locality"] },
          ],
        },
      ],
    });

    const result = await provider.geocode("12 Anna Salai, Chennai, India", signal);

    expect(result).not.toBeNull();
    expect(result!.latitude).toBeCloseTo(13.0604);
    expect(result!.longitude).toBeCloseTo(80.2496);
    expect(result!.precision).toBe("rooftop");
    // Most specific locality wins — this is the Location column's future value.
    expect(result!.locality).toBe("Anna Nagar West");
  });

  it("falls back to the locality component when there is no sublocality", async () => {
    mockFetch(200, {
      geocodingResults: [
        {
          geometry: { location: { lat: 12.9, lng: 79.1 } },
          location_type: "approximate",
          address_components: [{ long_name: "Vellore", types: ["locality"] }],
        },
      ],
    });

    const result = await provider.geocode("somewhere", signal);
    expect(result!.locality).toBe("Vellore");
    // An unrecognised location_type must be pessimistic, not optimistic.
    expect(result!.precision).toBe("locality");
  });

  it("returns null when the provider answered but matched nothing", async () => {
    mockFetch(200, { geocodingResults: [] });
    await expect(provider.geocode("nowhere at all", signal)).resolves.toBeNull();
  });

  it("returns null when a hit carries no usable coordinate", async () => {
    mockFetch(200, { geocodingResults: [{ formatted_address: "somewhere" }] });
    await expect(provider.geocode("somewhere", signal)).resolves.toBeNull();
  });

  // THE ONE THAT MATTERS MOST.
  it("THROWS retryably on HTTP 429 instead of caching a false negative", async () => {
    mockFetch(429, {});
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toThrow(
      GeocodeProviderError,
    );
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("throws retryably on 5xx", async () => {
    mockFetch(503, {});
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("throws NON-retryably on a bad request so the queue cannot spin", async () => {
    mockFetch(401, {});
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("throws on a quota error signalled in the body with HTTP 200", async () => {
    // The Google-style trap: 200 OK with the failure hidden in the payload.
    mockFetch(200, { status: "OVER_QUERY_LIMIT", message: "monthly limit reached" });
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("treats an explicit zero-results status as a real 'no match'", async () => {
    mockFetch(200, { status: "ZERO_RESULTS", geocodingResults: [] });
    await expect(provider.geocode("nowhere", signal)).resolves.toBeNull();
  });

  it("throws retryably when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: true,
    });
  });
});
