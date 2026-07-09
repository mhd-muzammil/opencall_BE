import { Router } from "express";
import {
  deleteRecordLayoutController,
  getRecordLayoutController,
  putRecordLayoutController,
} from "../controllers/recordLayoutController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";

// Per-user records-grid column layout. Every route operates on the
// authenticated user's own layout only — there is no cross-user access.
export const recordLayoutRouter = Router();

recordLayoutRouter.use(requireAuthenticatedUser);

recordLayoutRouter.get("/", getRecordLayoutController);
recordLayoutRouter.put("/", putRecordLayoutController);
recordLayoutRouter.delete("/", deleteRecordLayoutController);
