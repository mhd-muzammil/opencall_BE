import { describe, expect, it } from "vitest";
import {
  bearingDegrees,
  compassSector,
  distanceBand,
  formatDistanceCell,
  formatOfficeDistance,
  haversineKm,
  officeDistance,
  passesPincodeGate,
} from "./geo.js";

// The Maduravoyal branch office, and pincode centroids resolved from the All
// India Pincode Directory. The expected road distances are the ones the Chennai
// dispatcher quoted from experience, which is what this feature has to agree
// with to be trusted.
const MADURAVOYAL = { latitude: 13.054517, longitude: 80.177834 };
const ANNA_NAGAR = { latitude: 13.0872, longitude: 80.2101 };
const KOLATHUR = { latitude: 13.1244722, longitude: 80.2137778 };
const RED_HILLS = { latitude: 13.1957222, longitude: 80.1832778 };

describe("haversineKm", () => {
  it("is zero for a point against itself", () => {
    expect(haversineKm(MADURAVOYAL, MADURAVOYAL)).toBeCloseTo(0, 6);
  });

  it("is symmetric", () => {
    expect(haversineKm(MADURAVOYAL, KOLATHUR)).toBeCloseTo(
      haversineKm(KOLATHUR, MADURAVOYAL),
      9,
    );
  });

  it("ranks the three known Chennai runs in the right order", () => {
    const annaNagar = haversineKm(MADURAVOYAL, ANNA_NAGAR);
    const kolathur = haversineKm(MADURAVOYAL, KOLATHUR);
    const redHills = haversineKm(MADURAVOYAL, RED_HILLS);

    expect(annaNagar).toBeLessThan(kolathur);
    expect(kolathur).toBeLessThan(redHills);
  });
});

describe("officeDistance", () => {
  it("estimates Kolathur within a kilometre of the known 12.4 km road distance", () => {
    const result = officeDistance(MADURAVOYAL, KOLATHUR);
    expect(result).not.toBeNull();
    expect(result!.distanceKm).toBeGreaterThan(11.4);
    expect(result!.distanceKm).toBeLessThan(13.4);
  });

  it("puts Anna Nagar and Kolathur in adjacent northern sectors", () => {
    // This is what makes them pairable, and what a distance-only column hides.
    expect(officeDistance(MADURAVOYAL, ANNA_NAGAR)!.bearing).toBe("NE");
    expect(officeDistance(MADURAVOYAL, KOLATHUR)!.bearing).toBe("NNE");
  });

  it("separates Red Hills from the pairable calls by direction and distance", () => {
    // RED_HILLS here is the single Redhills S.O point (near due north); the
    // pipeline uses the 9-office centroid, which the western offices pull to
    // NNW. Either way the property that matters holds: it is not in the same
    // sector as the Anna Nagar / Kolathur pair, and it is much further out.
    const redHills = officeDistance(MADURAVOYAL, RED_HILLS)!;
    const kolathur = officeDistance(MADURAVOYAL, KOLATHUR)!;

    expect(redHills.bearing).not.toBe(officeDistance(MADURAVOYAL, ANNA_NAGAR)!.bearing);
    expect(redHills.bearing).not.toBe(kolathur.bearing);
    expect(redHills.distanceKm).toBeGreaterThan(kolathur.distanceKm);
  });

  it("returns null rather than guessing when either end lacks a coordinate", () => {
    expect(officeDistance(null, KOLATHUR)).toBeNull();
    expect(officeDistance(MADURAVOYAL, null)).toBeNull();
    expect(officeDistance(undefined, undefined)).toBeNull();
  });

  it("reports the straight line separately from the road estimate", () => {
    const result = officeDistance(MADURAVOYAL, KOLATHUR)!;
    expect(result.straightLineKm).toBeLessThan(result.distanceKm);
  });
});

describe("bearingDegrees / compassSector", () => {
  it("reads due north as N", () => {
    expect(compassSector(bearingDegrees(
      { latitude: 13.0, longitude: 80.0 },
      { latitude: 13.5, longitude: 80.0 },
    ))).toBe("N");
  });

  it("reads due east as E", () => {
    expect(compassSector(bearingDegrees(
      { latitude: 13.0, longitude: 80.0 },
      { latitude: 13.0, longitude: 80.5 },
    ))).toBe("E");
  });

  it("wraps 360 back to N", () => {
    expect(compassSector(359.9)).toBe("N");
    expect(compassSector(0)).toBe("N");
  });
});

describe("formatOfficeDistance", () => {
  it("puts distance and direction in one cell", () => {
    expect(formatOfficeDistance(officeDistance(MADURAVOYAL, KOLATHUR))).toMatch(
      /^\d+\.\d km \u00b7 NNE$/,
    );
  });

  it("renders an empty cell when there is no coordinate", () => {
    expect(formatOfficeDistance(null)).toBe("");
  });

  it("marks a straight-line estimate with a leading tilde", () => {
    // The estimate misses by 5.2km on average across the live Chennai set, so a
    // dispatcher has to be able to tell it from a routed figure at a glance.
    expect(formatDistanceCell(12.9, "NNE", false)).toBe("~12.9 km · NNE");
  });

  it("leaves a routed distance unmarked", () => {
    expect(formatDistanceCell(13.8, "NNE", true)).toBe("13.8 km · NNE");
  });

  it("treats an unspecified provenance as routed", () => {
    expect(formatDistanceCell(13.8, "NNE")).toBe("13.8 km · NNE");
  });

  it("still renders a distance that lost its bearing", () => {
    expect(formatDistanceCell(13.8, null, true)).toBe("13.8 km");
    expect(formatDistanceCell(13.8, "", false)).toBe("~13.8 km");
  });
});

describe("passesPincodeGate", () => {
  const centroid = { latitude: 13.05, longitude: 80.18 };

  it("accepts a coordinate inside its own pincode area", () => {
    // ~3 km — a rooftop a neighbourhood over from the pincode's centre.
    expect(passesPincodeGate({ latitude: 13.07, longitude: 80.2 }, centroid)).toBe(true);
  });

  it("rejects a billing-address answer far from the row's pincode", () => {
    // ~85 km — the measured Guindy-vs-Pallipattu trap this gate exists for.
    expect(passesPincodeGate({ latitude: 13.4, longitude: 79.5 }, centroid)).toBe(false);
  });
});

describe("distanceBand", () => {
  it("bands for the exact-match column filter", () => {
    expect(distanceBand(3)).toBe("0-5 km");
    expect(distanceBand(5)).toBe("0-5 km");
    expect(distanceBand(12.9)).toBe("5-15 km");
    expect(distanceBand(24.5)).toBe("15-30 km");
    expect(distanceBand(70)).toBe("30+ km");
  });

  it("is blank for an unknown distance", () => {
    expect(distanceBand(null)).toBe("");
    expect(distanceBand(undefined)).toBe("");
  });
});
