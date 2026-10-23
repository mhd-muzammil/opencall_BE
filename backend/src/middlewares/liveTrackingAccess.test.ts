import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { HttpError } from "../utils/httpError.js";
import { LIVE_TRACKING_SECTION, requireLiveTrackingAccess } from "./liveTrackingAccess.js";

/**
 * Who reaches the KM Report's km endpoints: whoever the Live Tracking section is
 * shown to, and nobody else -- above all not to POST /route-km and POST
 * /fieldez-km, where each call makes Payroll spend a metered Ola request.
 */

function user(role: "SUPER_ADMIN" | "REGION_ADMIN", accessibleSections: string[] | null) {
  return { id: "u1", email: "u@example.com", username: "u", role, regionId: null, region_id: null, mustChangePassword: false, accessibleSections };
}

function specialAccess(sections: string[]) {
  return { id: "s1", username: "s", roleId: null, roleName: null, sections, allRegions: true, regions: [], dataScope: "all", permissionLevel: "view" };
}

/** "allowed", or the refusal's status and message. */
function decide(request: Partial<Request>): string {
  let passed = false;
  try {
    requireLiveTrackingAccess(request as Request, {} as Response, (() => {
      passed = true;
    }) as NextFunction);
  } catch (error) {
    if (error instanceof HttpError) return `${error.statusCode}: ${error.message}`;
    throw error;
  }
  return passed ? "allowed" : "neither";
}

describe("requireLiveTrackingAccess", () => {
  it("lets a SUPER_ADMIN in, whatever is stored for its sections", () => {
    expect(decide({ currentUser: user("SUPER_ADMIN", null) } as never)).toBe("allowed");
    expect(decide({ currentUser: user("SUPER_ADMIN", ["warranty"]) } as never)).toBe("allowed");
  });

  it("lets a REGION_ADMIN in with all sections, or a list holding Live Tracking", () => {
    expect(decide({ currentUser: user("REGION_ADMIN", null) } as never)).toBe("allowed");
    expect(decide({ currentUser: user("REGION_ADMIN", ["warranty", LIVE_TRACKING_SECTION]) } as never)).toBe("allowed");
  });

  it("refuses a REGION_ADMIN whose section list leaves Live Tracking out", () => {
    expect(decide({ currentUser: user("REGION_ADMIN", ["warranty"]) } as never)).toBe("403: Live Tracking is not open to this user");
    expect(decide({ currentUser: user("REGION_ADMIN", []) } as never)).toBe("403: Live Tracking is not open to this user");
  });

  it("lets a special-access login in only when granted Live Tracking", () => {
    expect(decide({ specialAccess: specialAccess([LIVE_TRACKING_SECTION]) } as never)).toBe("allowed");
    expect(decide({ specialAccess: specialAccess(["customer-emails"]) } as never)).toBe("403: Live Tracking is not granted to this credential");
  });

  it("refuses vendor logins, even with a section of that name", () => {
    expect(decide({ vendorAccess: { id: "v1", username: "v", sections: [LIVE_TRACKING_SECTION], permissionLevel: "view" } } as never)).toBe(
      "403: Live Tracking is not available to vendor logins",
    );
  });

  it("refuses a request with no principal at all", () => {
    expect(decide({})).toBe("403: Authentication required");
  });
});
