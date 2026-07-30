import type { RequestHandler } from "express";
import {
  isRenewalLeadStatus,
  isRenewalWindow,
  type RenewalLeadStatus,
  type RenewalWindow,
} from "@opencall/shared";
import {
  getRenewalPipeline,
  saveRenewalLead,
  type RenewalPipelineOptions,
} from "../services/renewal/renewalService.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { unprocessableEntity } from "../utils/httpError.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The AMC / warranty renewal pipeline for the caller: leads whose HP warranty ends inside
 * the requested window, region-scoped, with their saved follow-up state.
 */
export const getRenewalPipelineController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);

    // Build the options object key-by-key: `exactOptionalPropertyTypes` forbids passing an
    // explicit `undefined` for an optional property.
    const options: RenewalPipelineOptions = {
      search: readString(request.query.search),
    };

    const windowParam = readString(request.query.window).trim().toUpperCase();
    if (windowParam) {
      if (!isRenewalWindow(windowParam)) {
        throw unprocessableEntity("window is not a valid renewal window", {
          window: windowParam,
        });
      }
      options.window = windowParam satisfies RenewalWindow;
    }

    const statusParam = readString(request.query.status).trim();
    if (statusParam && statusParam.toUpperCase() !== "ALL") {
      if (!isRenewalLeadStatus(statusParam)) {
        throw unprocessableEntity("status is not a valid renewal lead status", {
          status: statusParam,
        });
      }
      options.status = statusParam satisfies RenewalLeadStatus;
    }

    response.json({ data: await getRenewalPipeline(user, options) });
  },
);

/** Save the follow-up state (status / owner / remarks) of one renewal lead. */
export const saveRenewalLeadController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const status = readString(body.status).trim();
    if (!isRenewalLeadStatus(status)) {
      throw unprocessableEntity("status is not a valid renewal lead status", { status });
    }

    response.json({
      data: await saveRenewalLead(user, {
        serial: readString(body.serial),
        status,
        owner: readString(body.owner),
        remarks: readString(body.remarks),
      }),
    });
  },
);
