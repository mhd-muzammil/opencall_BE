import { describe, expect, it } from "vitest";
import { parseClientLocationHeader } from "./clientLocation.js";
import { buildAddressLabel, coordinateKey } from "./reverseGeocodeService.js";

const NOW = Date.UTC(2026, 10, 14, 6, 30, 0);

describe("parseClientLocationHeader", () => {
  it("reads a fresh fix", () => {
    expect(parseClientLocationHeader(`13.0418,80.2341,24.6,${NOW - 60_000}`, NOW)).toEqual({
      status: "ok",
      lat: 13.0418,
      lon: 80.2341,
      accuracyM: 25,
      capturedAt: new Date(NOW - 60_000).toISOString(),
    });
  });

  it("passes through denied / unavailable", () => {
    expect(parseClientLocationHeader("denied", NOW)).toEqual({ status: "denied" });
    expect(parseClientLocationHeader(" Unavailable ", NOW)).toEqual({ status: "unavailable" });
  });

  it("treats a stale or future-dated fix as unavailable, not as a location", () => {
    expect(parseClientLocationHeader(`13,80,10,${NOW - 16 * 60_000}`, NOW)).toEqual({
      status: "unavailable",
    });
    expect(parseClientLocationHeader(`13,80,10,${NOW + 10 * 60_000}`, NOW)).toEqual({
      status: "unavailable",
    });
  });

  it("ignores missing or malformed values", () => {
    expect(parseClientLocationHeader(undefined, NOW)).toBeNull();
    expect(parseClientLocationHeader("", NOW)).toBeNull();
    expect(parseClientLocationHeader("13,80", NOW)).toBeNull();
    expect(parseClientLocationHeader(`abc,80,10,${NOW}`, NOW)).toBeNull();
    expect(parseClientLocationHeader(`95,80,10,${NOW}`, NOW)).toBeNull();
    expect(parseClientLocationHeader(`13,80,-5,${NOW}`, NOW)).toBeNull();
  });
});

describe("buildAddressLabel", () => {
  it("builds street, area, city + pincode", () => {
    expect(
      buildAddressLabel({
        road: "Anna Salai",
        suburb: "Teynampet",
        city: "Chennai",
        postcode: "600018",
        state: "Tamil Nadu",
      }),
    ).toBe("Anna Salai, Teynampet, Chennai 600018");
  });

  it("falls back to town/village and then state", () => {
    expect(buildAddressLabel({ village: "Koonavelampatti", postcode: "637401" })).toBe(
      "Koonavelampatti 637401",
    );
    expect(buildAddressLabel({ state: "Tamil Nadu" })).toBe("Tamil Nadu");
    expect(buildAddressLabel(undefined)).toBeNull();
  });

  it("keys points at ~11 m resolution", () => {
    expect(coordinateKey(13.041812, 80.234149)).toBe(coordinateKey(13.04183, 80.23412));
  });
});
