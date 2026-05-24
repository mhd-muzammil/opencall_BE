import type { RequestHandler } from "express";
import bcrypt from "bcryptjs";
import {
  findActiveUserWithPasswordByLogin,
  touchLastLogin,
} from "../repositories/userRepository.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { unauthorized } from "../utils/httpError.js";
import { generateToken } from "../utils/jwt.js";
import { loginRequestSchema } from "../validators/loginRequestValidator.js";

export const loginController: RequestHandler = asyncHandler(
  async (request, response) => {
    const input = loginRequestSchema.parse(request.body);
    const record = await findActiveUserWithPasswordByLogin(input.username);

    if (!record) {
      throw unauthorized("Invalid login credentials");
    }

    const passwordMatches = await bcrypt.compare(input.password, record.passwordHash);

    if (!passwordMatches) {
      throw unauthorized("Invalid login credentials");
    }

    await touchLastLogin(record.user.id);

    response.status(200).json({
      data: {
        token: generateToken(record.user),
        user: record.user,
      },
    });
  },
);
