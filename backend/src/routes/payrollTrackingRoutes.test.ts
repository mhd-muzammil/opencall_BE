import { describe, expect, it, vi } from "vitest";

/**
 * How /payroll-tracking is wired: the KM Report's five km endpoints sit behind
 * the Live Tracking check (so not every signed-in user can make Payroll spend
 * Ola requests), registered before the router-wide sign-in guard; everything
 * else stays behind that guard exactly as before.
 */

// The guards and controllers reach the database through these; nothing here asks it anything.
vi.mock("../repositories/userRepository.js", () => ({ findActiveUserById: vi.fn() }));
vi.mock("../repositories/specialAccessRepository.js", () => ({ findActiveSpecialAccessForPrincipal: vi.fn() }));
vi.mock("../repositories/vendorAccessRepository.js", () => ({ findActiveVendorAccessForPrincipal: vi.fn() }));
vi.mock("../repositories/engineerRepository.js", () => ({ findEngineerContactByName: vi.fn(), listEngineersForDropdown: vi.fn() }));
// The token helpers read the JWT secrets from the environment on import.
vi.mock("../utils/jwt.js", () => ({ verifyToken: vi.fn(), verifyAnyToken: vi.fn(), SPECIAL_ACCESS_TOKEN_KIND: "special", VENDOR_ACCESS_TOKEN_KIND: "vendor" }));

interface Layer {
  handle: unknown;
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
}

async function wiring() {
  const { payrollTrackingRouter } = await import("./payrollTrackingRoutes.js");
  const { requireAuthenticatedUser, requirePrincipal } = await import("../middlewares/authMiddleware.js");
  const { requireLiveTrackingAccess } = await import("../middlewares/liveTrackingAccess.js");
  const stack = (payrollTrackingRouter as unknown as { stack: Layer[] }).stack;
  const signedIn = stack.findIndex((layer) => !layer.route && layer.handle === requireAuthenticatedUser);
  const routes = stack
    .map((layer, index) => ({ layer, index }))
    .filter(({ layer }) => layer.route)
    .map(({ layer, index }) => ({
      key: `${Object.keys(layer.route!.methods)[0]!.toUpperCase()} ${layer.route!.path}`,
      index,
      handlers: layer.route!.stack.map((entry) => entry.handle),
    }));
  return { routes, signedIn, requirePrincipal, requireLiveTrackingAccess };
}

const KM = ["POST /route-km", "POST /fieldez-km", "GET /route-km/stored", "GET /fieldez-km/stored", "GET /cases-by-day/stored"];

describe("payrollTrackingRouter", () => {
  it.each(KM)("%s: a principal, then the Live Tracking check, then the controller -- before the sign-in guard", async (key) => {
    const { routes, signedIn, requirePrincipal, requireLiveTrackingAccess } = await wiring();
    const matches = routes.filter((route) => route.key === key);
    expect(matches).toHaveLength(1);
    const [route] = matches;
    expect(route!.handlers.slice(0, 2)).toEqual([requirePrincipal, requireLiveTrackingAccess]);
    expect(route!.handlers).toHaveLength(3);
    expect(route!.index).toBeLessThan(signedIn);
  });

  it("everything else stays behind the router-wide sign-in guard, as before", async () => {
    const { routes, signedIn } = await wiring();
    expect(signedIn).toBeGreaterThanOrEqual(0);
    const others = routes.filter((route) => !KM.includes(route.key));
    expect(others.map((route) => route.key)).toEqual(
      expect.arrayContaining(["GET /live", "GET /roster", "GET /roster/km", "GET /roster/km/days", "GET /route-km/day/engineer/:engineerId", "POST /cases-by-day"]),
    );
    for (const route of others) expect(route.index).toBeGreaterThan(signedIn);
  });
});
