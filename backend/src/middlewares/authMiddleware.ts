import type { RequestHandler } from "express";
import { findActiveUserById } from "../repositories/userRepository.js";
import { findActiveSpecialAccessForPrincipal } from "../repositories/specialAccessRepository.js";
import type { SpecialAccessPrincipal } from "../types/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { unauthorized } from "../utils/httpError.js";
import {
  verifyToken,
  verifyAnyToken,
  SPECIAL_ACCESS_TOKEN_KIND,
} from "../utils/jwt.js";
import type { SpecialAccessRecord } from "../repositories/specialAccessRepository.js";

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

    const user = await findActiveUserById(verified.payload.userId);
    if (!user) {
      throw unauthorized("Authenticated user was not found or is inactive");
    }
    request.currentUser = user;
    next();
  },
);
