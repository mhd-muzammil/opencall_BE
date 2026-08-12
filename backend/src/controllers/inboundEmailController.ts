import type { RequestHandler } from "express";
import {
  listActiveMailboxes,
  listInboundEmails,
  setInboundEmailStatus,
} from "../repositories/inboundEmailRepository.js";
import { pollAllMailboxes } from "../services/inboundEmail/inboundEmailService.js";
import {
  findAllowedRegionsForUser,
  requireCurrentUser,
} from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { unprocessableEntity } from "../utils/httpError.js";

/**
 * Customer Emails — Stage 1 is read + triage only. There is no send endpoint here on
 * purpose; replies are a later stage.
 */

const ALLOWED_STATUS = new Set(["NEW", "REVIEWED", "IGNORED"]);

/** The inbox: newest first, region-scoped, with the mailbox poll health alongside. */
export const listInboundEmailsController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);

    const regions = await findAllowedRegionsForUser(user);
    const regionCodes =
      regions === null ? null : regions.map((r) => r.name.trim().toUpperCase());

    const status = String(request.query.status ?? "ALL").trim().toUpperCase();
    const parsedLimit = Number(request.query.limit ?? 100);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 500)
      : 100;

    const [rows, mailboxes] = await Promise.all([
      listInboundEmails({ status, regionCodes, limit }),
      listActiveMailboxes(),
    ]);

    response.json({
      data: {
        rows,
        mailboxes: mailboxes.filter(
          (m) => !regionCodes || regionCodes.includes(m.regionCode.toUpperCase()),
        ),
      },
    });
  },
);

/** Triage: mark a message reviewed or ignored. Does not touch the mailbox itself. */
export const setInboundEmailStatusController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);

    const id = String(request.params.id ?? "").trim();
    const status = String((request.body ?? {}).status ?? "").trim().toUpperCase();
    if (!id) throw unprocessableEntity("Missing email id");
    if (!ALLOWED_STATUS.has(status)) {
      throw unprocessableEntity("status must be NEW, REVIEWED or IGNORED", { status });
    }

    await setInboundEmailStatus(id, status);
    response.json({ data: { id, status } });
  },
);

/**
 * Run a poll now instead of waiting for the worker. Still read-only — it fetches and
 * stores, and cannot send anything.
 */
export const pollInboundEmailsController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    response.json({ data: { results: await pollAllMailboxes() } });
  },
);
