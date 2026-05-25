import type { RequestHandler } from "express";
import bcrypt from "bcryptjs";
import {
  findActiveUserWithPasswordByLogin,
  touchLastLogin,
} from "../repositories/userRepository.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { unauthorized } from "../utils/httpError.js";
import { generateToken } from "../utils/jwt.js";
import { loginRequestSchema } from "../validators/loginRequestValidator.js";

export const loginController: RequestHandler = asyncHandler(
  async (request, response) => {
    const input = loginRequestSchema.parse(request.body);
    const record = await findActiveUserWithPasswordByLogin(input.username);

    if (!record) {
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
