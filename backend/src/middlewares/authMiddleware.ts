import type { RequestHandler } from "express";
import { findActiveUserById } from "../repositories/userRepository.js";
import { findActiveSpecialAccessForPrincipal } from "../repositories/specialAccessRepository.js";
import { findActiveVendorAccessForPrincipal } from "../repositories/vendorAccessRepository.js";
import type { SpecialAccessPrincipal, VendorAccessPrincipal } from "../types/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { unauthorized, forbidden } from "../utils/httpError.js";
import {
  verifyToken,
  verifyAnyToken,
  SPECIAL_ACCESS_TOKEN_KIND,
  VENDOR_ACCESS_TOKEN_KIND,
} from "../utils/jwt.js";
import type { SpecialAccessRecord } from "../repositories/specialAccessRepository.js";
import type { VendorAccessRecord } from "../repositories/vendorAccessRepository.js";

function getBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw unauthorized("Missing Authorization header");
  }

  const [scheme, token] = authorizationHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw unauthorized("Authorization header must use Bearer token");
  }

  return token;
}

function toPrincipal(record: SpecialAccessRecord): SpecialAccessPrincipal {
  return {
    id: record.id,
    username: record.username,
    roleId: record.roleId,
    roleName: record.roleName,
    sections: record.sections,
    allRegions: record.allRegions,
    regions: record.regions,
    dataScope: record.dataScope,
    permissionLevel: record.permissionLevel,
  };
}

function toVendorPrincipal(record: VendorAccessRecord): VendorAccessPrincipal {
  return {
    id: record.id,
    username: record.username,
    sections: record.sections,
    permissionLevel: record.permissionLevel,
  };
}

/**
 * Regular-user authentication — UNCHANGED behaviour. A special-access token fails
 * `verifyToken` (it has no user payload) and is rejected with 401, so every route that
 * uses this guard (admin + all existing operational routes) stays exactly as before and
 * remains inaccessible to special-access credentials.
 */
export const requireAuthenticatedUser: RequestHandler = asyncHandler(
  async (request, _response, next) => {
    const token = getBearerToken(request.header("authorization"));
    const payload = verifyToken(token);

    const user = await findActiveUserById(payload.userId);

    if (!user) {
      throw unauthorized("Authenticated user was not found or is inactive");
    }

    request.currentUser = user;
    next();
  },
);

/**
 * Accepts EITHER a regular user OR a special-access credential. For regular users it
 * behaves identically to `requireAuthenticatedUser` (sets `request.currentUser`); for
 * special-access it re-loads the credential fresh and sets `request.specialAccess`.
 * Use this only on operational read endpoints that special-access logins may reach.
 */
export const requirePrincipal: RequestHandler = asyncHandler(
  async (request, _response, next) => {
    const token = getBearerToken(request.header("authorization"));
    const verified = verifyAnyToken(token);

    if (verified.kind === SPECIAL_ACCESS_TOKEN_KIND) {
      const record = await findActiveSpecialAccessForPrincipal(
        verified.specialAccessId,
      );
      if (!record) {
        throw unauthorized("Special-access credential was not found or is inactive");
      }
      request.specialAccess = toPrincipal(record);
      next();
      return;
    }

    if (verified.kind === VENDOR_ACCESS_TOKEN_KIND) {
      const record = await findActiveVendorAccessForPrincipal(
        verified.vendorAccessId,
      );
      if (!record) {
        throw unauthorized("Vendor-access credential was not found or is inactive");
      }
      request.vendorAccess = toVendorPrincipal(record);
      next();
      return;
    }

    const user = await findActiveUserById(verified.payload.userId);
    if (!user) {
      throw unauthorized("Authenticated user was not found or is inactive");
    }
    request.currentUser = user;
    next();
  },
);

/**
 * Vendor-only guard for the vendor portal endpoints. Resolves a vendor-access token onto
 * `request.vendorAccess` and rejects everything else (users, special-access) with 403 —
 * so a regular or special-access token can never reach a vendor endpoint.
 */
export const requireVendorAccess: RequestHandler = asyncHandler(
  async (request, _response, next) => {
    const token = getBearerToken(request.header("authorization"));
    const verified = verifyAnyToken(token);

    if (verified.kind !== VENDOR_ACCESS_TOKEN_KIND) {
      throw forbidden("Vendor access required");
    }

    const record = await findActiveVendorAccessForPrincipal(verified.vendorAccessId);
    if (!record) {
      throw unauthorized("Vendor-access credential was not found or is inactive");
    }
    request.vendorAccess = toVendorPrincipal(record);
    next();
  },
);
