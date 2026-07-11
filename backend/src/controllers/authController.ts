import type { RequestHandler } from "express";
import bcrypt from "bcryptjs";
import {
  findActiveUserWithPasswordByLogin,
  touchLastLogin,
} from "../repositories/userRepository.js";
import { findActiveSpecialAccessByUsername } from "../repositories/specialAccessRepository.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { unauthorized } from "../utils/httpError.js";
import { generateToken, generateSpecialAccessToken } from "../utils/jwt.js";
import { loginRequestSchema } from "../validators/loginRequestValidator.js";

/**
 * Fallback login path for special-access credentials (rows in `special_access`, not
 * `users`). Only reached when no regular user matched the supplied username, so the
 * existing user-login behaviour is completely unaffected. Returns null when there is no
 * matching/valid special-access credential so the caller can fail as before.
 */
async function trySpecialAccessLogin(
  username: string,
  password: string,
  request: Parameters<RequestHandler>[0],
): Promise<{ token: string; user: unknown; specialAccess: unknown } | null> {
  const match = await findActiveSpecialAccessByUsername(username);
  if (!match) {
    return null;
  }

  const passwordMatches = await bcrypt.compare(password, match.passwordHash);
  if (!passwordMatches) {
    recordActivity({
      eventType: "LOGIN_FAILED",
      actorEmailFallback: username,
      status: "FAILURE",
      metadata: { reason: "BAD_PASSWORD", kind: "SPECIAL_ACCESS" },
      request,
    });
    throw unauthorized("Invalid login credentials");
  }

  const { record } = match;
  recordActivity({
    eventType: "LOGIN_SUCCESS",
    actorEmailFallback: record.username,
    metadata: { kind: "SPECIAL_ACCESS", specialAccessId: record.id },
    request,
  });

  return {
    token: generateSpecialAccessToken(record.id),
    user: {
      id: record.id,
      username: record.username,
      email: null,
      role: "SPECIAL_ACCESS",
      regionId: null,
      region_id: null,
      mustChangePassword: false,
    },
    specialAccess: {
      id: record.id,
      username: record.username,
      roleName: record.roleName,
      sections: record.sections,
      allRegions: record.allRegions,
      regions: record.regions,
      dataScope: record.dataScope,
      permissionLevel: record.permissionLevel,
    },
  };
}

export const loginController: RequestHandler = asyncHandler(
  async (request, response) => {
    const input = loginRequestSchema.parse(request.body);
    const record = await findActiveUserWithPasswordByLogin(input.username);

    if (!record) {
      const specialAccess = await trySpecialAccessLogin(
        input.username,
        input.password,
        request,
      );
      if (specialAccess) {
        response.status(200).json({ data: specialAccess });
        return;
      }

      recordActivity({
        eventType: "LOGIN_FAILED",
        actorEmailFallback: input.username,
        status: "FAILURE",
        metadata: { reason: "USER_NOT_FOUND" },
        request,
      });
      throw unauthorized("Invalid login credentials");
    }

    const passwordMatches = await bcrypt.compare(input.password, record.passwordHash);

    if (!passwordMatches) {
      recordActivity({
        eventType: "LOGIN_FAILED",
        actor: {
          id: record.user.id,
          email: record.user.email,
          role: record.user.role,
        },
        regionId: record.user.regionId,
        status: "FAILURE",
        metadata: { reason: "BAD_PASSWORD" },
        request,
      });
      throw unauthorized("Invalid login credentials");
    }

    await touchLastLogin(record.user.id);

    recordActivity({
      eventType: "LOGIN_SUCCESS",
      actor: {
        id: record.user.id,
        email: record.user.email,
        role: record.user.role,
      },
      regionId: record.user.regionId,
      request,
    });

    response.status(200).json({
      data: {
        token: generateToken(record.user),
        user: record.user,
      },
    });
  },
);
