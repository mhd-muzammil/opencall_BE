import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenCageProvider } from "./openCageProvider.js";

const provider = createOpenCageProvider("test-key");
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

function hit(result: Record<string, unknown>) {
  return { status: { code: 200, message: "OK" }, results: [result] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openCageProvider", () => {
  it("declares the free tier's hard 1 req/sec floor", () => {
    // Without this the worker's 250ms default turns the run into a 429 storm,
    // and each 429 burns an attempt against GEOCODE_MAX_ATTEMPTS.
    expect(provider.minRequestSpacingMs).toBeGreaterThanOrEqual(1_000);
  });

  it("reads coordinates, precision and locality from a building hit", async () => {
    mockFetch(
      200,
      hit({
        geometry: { lat: 13.0604, lng: 80.2496 },
        formatted: "12 Anna Salai, Chennai, Tamil Nadu 600002, India",
        components: {
          _type: "building",
          house_number: "12",
          road: "Anna Salai",
          suburb: "Anna Nagar West",
          city: "Chennai",
        },
      }),
    );

    const result = await provider.geocode("12 Anna Salai, Chennai, India", signal);

    expect(result!.latitude).toBeCloseTo(13.0604);
    expect(result!.longitude).toBeCloseTo(80.2496);
    expect(result!.precision).toBe("rooftop");
    expect(result!.locality).toBe("Anna Nagar West");
  });

  it("maps a road result to street precision", async () => {
    mockFetch(
      200,
      hit({ geometry: { lat: 12.9, lng: 79.1 }, components: { _type: "road", road: "Arni Road", city: "Vellore" } }),
    );
    const result = await provider.geocode("Arni Road", signal);
    expect(result!.precision).toBe("street");
  });

  it("prefers village over city in the semi-urban belt", async () => {
    // The `city` field is often the district HQ rather than where the engineer
    // is actually going.
    mockFetch(
      200,
      hit({
        geometry: { lat: 12.6, lng: 78.1 },
        components: { _type: "village", village: "Perandapalli", city: "Hosur" },
      }),
    );
    const result = await provider.geocode("Perandapalli", signal);
    expect(result!.locality).toBe("Perandapalli");
  });

  it("does not treat a high confidence score as rooftop", async () => {
    // confidence describes how SMALL the bounding box is, not how precisely the
    // address matched — a tight box around the wrong village scores well.
    mockFetch(
      200,
      hit({ geometry: { lat: 12.9, lng: 79.1 }, confidence: 10, components: { _type: "village", village: "X" } }),
    );
    const result = await provider.geocode("X", signal);
    expect(result!.precision).toBe("locality");
  });

  it("returns null when nothing matched", async () => {
    mockFetch(200, { status: { code: 200 }, results: [] });
    await expect(provider.geocode("nowhere at all", signal)).resolves.toBeNull();
  });

  // THE ONE THAT MATTERS MOST FOR THIS VENDOR.
  it("THROWS retryably on HTTP 402 quota-exceeded, not as a bad request", async () => {
    // OpenCage signals quota exhaustion with 402, not 429. Classifying it as a
    // 4xx bad request would fail every queued address permanently the moment the
    // daily allowance ran out.
    mockFetch(402, {});
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("throws retryably on HTTP 429", async () => {
    mockFetch(429, {});
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("throws retryably when 402 arrives inside a 200 body", async () => {
    mockFetch(200, { status: { code: 402, message: "quota exceeded" }, results: [] });
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("throws NON-retryably on a bad key", async () => {
    mockFetch(403, {});
    await expect(provider.geocode("12 Anna Salai", signal)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("requests only Indian results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ status: { code: 200 }, results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await provider.geocode("12 Anna Salai", signal);

    const requested = String(fetchMock.mock.calls[0]![0]);
    expect(requested).toContain("countrycode=in");
  });
});
