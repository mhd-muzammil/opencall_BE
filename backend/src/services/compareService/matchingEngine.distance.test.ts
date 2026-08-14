import { describe, expect, it } from "vitest";
import { resolveOfficeDistance } from "./matchingEngine.js";
import {
  addressRoadDistanceKey,
  roadDistanceKey,
} from "../../repositories/geoRepository.js";
import { normalizeTicketId } from "../normalization/valueNormalizer.js";
import type { FlexWipParsedRecord } from "../../types/sourceRecords.js";
import type { MatchedCallPlanInput } from "../../types/matching.js";

// The three-tier distance decision: exact address when geocoded AND routed AND
// sane, else routed pincode centroid, else straight-line estimate. Locked here
// because every tier silently falling back to the next is exactly the kind of
// behaviour that regresses without anyone noticing — the cell still shows a
// plausible number either way.

const ASP = "ASPS01461";
const PINCODE = "600101";
const TICKET = "WO-035500001";

const office = { latitude: 13.054517, longitude: 80.177834 };
// ~7 km NE of the office; the pincode's own centre.
const centroid = { latitude: 13.108, longitude: 80.218 };
// ~1 km from the centroid — a plausible rooftop inside the same pincode.
const nearbyRooftop = { latitude: 13.117, longitude: 80.218, addressKey: "addr-1" };
// ~85 km away — the measured billing-address trap (address in one town, site in another).
const farAwayRooftop = { latitude: 13.4, longitude: 79.5, addressKey: "addr-1" };

const flexWip = {
  ticketId: TICKET,
  workLocation: ASP,
  customerPincode: PINCODE,
} as unknown as FlexWipParsedRecord;

function baseInput(overrides: Partial<MatchedCallPlanInput> = {}): MatchedCallPlanInput {
  return {
    flexWip: [],
    renderways: [],
    callPlan: [],
    officeByAspCode: new Map([[ASP, office]]),
    coordinatesByPincode: new Map([[PINCODE, centroid]]),
    roadDistanceByOfficePincode: new Map([[roadDistanceKey(ASP, PINCODE), 13.8]]),
    ...overrides,
  };
}

function preciseMaps(
  point: { latitude: number; longitude: number; addressKey: string },
  addressRoadKm: number | null,
): Partial<MatchedCallPlanInput> {
  return {
    preciseCoordByTicketId: new Map([[normalizeTicketId(TICKET), point]]),
    roadDistanceByOfficeAddress:
      addressRoadKm === null
        ? new Map()
        : new Map([[addressRoadDistanceKey(ASP, point.addressKey), addressRoadKm]]),
  };
}

describe("resolveOfficeDistance — exact-address tier", () => {
  it("prefers the routed exact-address distance when geocoded, routed and sane", () => {
    const result = resolveOfficeDistance(
      flexWip,
      baseInput(preciseMaps(nearbyRooftop, 9.4)),
    );
    expect(result).toMatchObject({ distanceKm: 9.4, routed: true });
  });

  it("stays on the routed pincode tier while the address route is missing", () => {
    // Never downgrade a routed centroid figure to a straight-line "precise" one:
    // the coordinate improved but the number on screen would get worse.
    const result = resolveOfficeDistance(
      flexWip,
      baseInput(preciseMaps(nearbyRooftop, null)),
    );
    expect(result).toMatchObject({ distanceKm: 13.8, routed: true });
  });

  it("rejects a geocode far from the row's own pincode (billing-address trap)", () => {
    const result = resolveOfficeDistance(
      flexWip,
      baseInput(preciseMaps(farAwayRooftop, 60)),
    );
    expect(result).toMatchObject({ distanceKm: 13.8, routed: true });
  });

  it("keeps the straight-line estimate when nothing is routed at all", () => {
    const result = resolveOfficeDistance(
      flexWip,
      baseInput({ roadDistanceByOfficePincode: new Map() }),
    );
    expect(result?.routed).toBe(false);
    expect(result?.distanceKm).toBeGreaterThan(0);
  });

  it("is blank for a branch with no surveyed office, precise geocode or not", () => {
    const result = resolveOfficeDistance(
      flexWip,
      baseInput({
        officeByAspCode: new Map(),
        ...preciseMaps(nearbyRooftop, 9.4),
      }),
    );
    expect(result).toBeNull();
  });
});
