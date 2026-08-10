import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeoapifyProvider } from "./geoapifyProvider.js";
import { GeocodeProviderError } from "../geocodeTypes.js";

const provider = createGeoapifyProvider("test-key");
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

function feature(properties: Record<string, unknown>) {
  return { features: [{ properties }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("geoapifyProvider", () => {
  it("reads coordinates, precision and locality from a building hit", async () => {
    mockFetch(
      200,
      feature({
        lat: 13.0604,
        lon: 80.2496,
        formatted: "12 Anna Salai, Chennai, Tamil Nadu 600002, India",
        result_type: "building",
        suburb: "Anna Nagar West",
        city: "Chennai",
      }),
    );

    const result = await provider.geocode("12 Anna Salai, Chennai, India", signal);

    expect(result!.latitude).toBeCloseTo(13.0604);
    expect(result!.longitude).toBeCloseTo(80.2496);
    expect(result!.precision).toBe("rooftop");
    // Suburb beats city — this is the Location column's future value.
    expect(result!.locality).toBe("Anna Nagar West");
  });

  it("maps a street result to street precision", async () => {
    mockFetch(200, feature({ lat: 12.9, lon: 79.1, result_type: "street", city: "Vellore" }));
    const result = await provider.geocode("some road", signal);
    expect(result!.precision).toBe("street");
    expect(result!.locality).toBe("Vellore");
  });

  it("treats a coarse type carrying a house number as rooftop", async () => {
    // Geoapify types some Indian plot addresses coarsely even with full detail.
    mockFetch(
      200,
      feature({ lat: 12.9, lon: 79.1, result_type: "postcode", housenumber: "52", street: "Arni Road" }),
    );
    const result = await provider.geocode("52 Arni Road", signal);
    expect(result!.precision).toBe("rooftop");
  });

  it("falls back pessimistically to locality on an unknown type", async () => {
    mockFetch(200, feature({ lat: 12.9, lon: 79.1, result_type: "something_new" }));
    const result = await provider.geocode("somewhere", signal);
    expect(result!.precision).toBe("locality");
  });

  it("returns null when nothing matched", async () => {
    mockFetch(200, { features: [] });
    await expect(provider.geocode("nowhere at all", signal)).resolves.toBeNull();
  });

  it("returns null when a hit carries no coordinate", async () => {
    mockFetch(200, feature({ formatted: "somewhere" }));
    await expect(provider.geocode("somewhere", signal)).resolves.toBeNull();
  });

  it("THROWS retryably on 429 rather than caching a false negative", async () => {
    mockFetch(429, {});
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("throws retryably on 5xx", async () => {
    mockFetch(500, {});
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("throws NON-retryably on a bad key so the queue cannot spin", async () => {
    mockFetch(401, {});
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("throws when an error is described in the body of a 200", async () => {
    mockFetch(200, { error: "Rate limit exceeded" });
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toThrow(
      GeocodeProviderError,
    );
  });

  it("requests only Indian results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ features: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await provider.geocode("12 Anna Salai", signal);

    // Without the country filter an Indian street name can match a US one and
    // the result looks entirely plausible.
    const requested = String(fetchMock.mock.calls[0]![0]);
    expect(requested).toContain("filter=countrycode%3Ain");
  });
});
