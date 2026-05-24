import { Router } from "express";
import {
  changeOwnPasswordController,
  getMeController,
} from "../controllers/meController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";

export const meRouter = Router();

meRouter.use(requireAuthenticatedUser);

meRouter.get("/", getMeController);
meRouter.post("/password", changeOwnPasswordController);
