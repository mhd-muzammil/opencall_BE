import { Router } from "express";
import { loginController } from "../controllers/authController.js";
import { loginRateLimiter } from "../middlewares/loginRateLimit.js";

export const authRouter = Router();

authRouter.post("/login", loginRateLimiter, loginController);
