import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, forbidden } from "../utils/httpError.js";
import {
  createAcerCalls,
  deleteAcerCall,
  listAcerCalls,
  listRecentAcerCalls,
  previewAcerPaste,
  reopenAcerCall,
  updateAcerCall,
  type AcerCallInput,
} from "../services/brandCalls/brandCallService.js";

/** The paste box's limit: generous for a day's calls, small enough to refuse a mistake. */
const MAX_PASTE_CHARS = 200_000;

function actorLabel(request: Parameters<RequestHandler>[0]): string {
  const user = request.currentUser;
  if (!user) {
    throw forbidden("Authentication required");
  }
  return user.username ?? user.email ?? user.id;
}

/** POST /brand-calls/acer/preview { text } — reads the paste; saves nothing. */
export const previewAcerCallsController: RequestHandler = asyncHandler(
  async (request, response) => {
    actorLabel(request);
    const text = (request.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || !text.trim()) {
      throw badRequest("Paste the Acer calls first.", { field: "text" });
    }
    if (text.length > MAX_PASTE_CHARS) {
      throw badRequest("That paste is too long. Paste a day's calls at a time.", { field: "text" });
    }
    response.json({ data: await previewAcerPaste(text) });
  },
);

/** POST /brand-calls/acer { calls: [...] } — saves the calls confirmed on the preview. */
export const createAcerCallsController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = actorLabel(request);
    const calls = (request.body as { calls?: unknown } | undefined)?.calls;
    if (!Array.isArray(calls)) {
      throw badRequest("Send the calls to save.", { field: "calls" });
    }
    const result = await createAcerCalls(calls as AcerCallInput[], actor);
    response.status(201).json({ data: result });
  },
);

/** GET /brand-calls/acer/recent — the latest calls entered, newest first. */
export const listRecentAcerCallsController: RequestHandler = asyncHandler(
  async (request, response) => {
    actorLabel(request);
    const limit = Number(request.query.limit ?? 50);
    response.json({ data: await listRecentAcerCalls(Number.isFinite(limit) ? limit : 50) });
  },
);

function currentUser(request: Parameters<RequestHandler>[0]) {
  const user = request.currentUser;
  if (!user) {
    throw forbidden("Authentication required");
  }
  return user;
}

function routeId(request: Parameters<RequestHandler>[0]): string {
  const id = String(request.params.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw badRequest("Unknown call id.", { field: "id" });
  }
  return id;
}

/** GET /brand-calls/acer?status=open|closed|all&search=&limit= — the "All calls" list. */
export const listAcerCallsController: RequestHandler = asyncHandler(async (request, response) => {
  const user = currentUser(request);
  const rawStatus = String(request.query.status ?? "all");
  const status = rawStatus === "open" || rawStatus === "closed" ? rawStatus : "all";
  const data = await listAcerCalls({
    user,
    status,
    search: String(request.query.search ?? "").slice(0, 100),
    limit: Number(request.query.limit ?? 300),
  });
  response.json({ data });
});

/** PATCH /brand-calls/acer/:id — corrects a saved call (SUPER_ADMIN). */
export const updateAcerCallController: RequestHandler = asyncHandler(async (request, response) => {
  const actor = actorLabel(request);
  const body = (request.body ?? {}) as AcerCallInput;
  response.json({ data: await updateAcerCall(routeId(request), body, actor) });
});

/** DELETE /brand-calls/acer/:id — removes a call entered by mistake (SUPER_ADMIN). */
export const deleteAcerCallController: RequestHandler = asyncHandler(async (request, response) => {
  const actor = actorLabel(request);
  response.json({ data: await deleteAcerCall(routeId(request), actor) });
});

/** POST /brand-calls/acer/:id/reopen — reopens a closed call. */
export const reopenAcerCallController: RequestHandler = asyncHandler(async (request, response) => {
  const user = currentUser(request);
  response.json({ data: await reopenAcerCall({ user, id: routeId(request) }) });
});
