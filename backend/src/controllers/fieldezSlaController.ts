import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import {
  deleteSlaOlderThan,
  getSlaFreshness,
  listAllSla,
  listWantedTicketNumbers,
  upsertSlaRecords,
} from "../repositories/fieldezSlaRepository.js";
import {
  parseSlaEndTime,
  ticketKey,
  type FieldezSlaRecord,
} from "../services/fieldezSla/fieldezSlaParse.js";

/**
 * FieldEZ's SLA for every open call: read by the screens, written by the FieldEZ worker.
 *
 * The worker is the only writer because it is the only process with a FieldEZ session. It
 * pushes here rather than the API pulling from FieldEZ, which keeps a lapsed FieldEZ login
 * or a slow FieldEZ from ever making OpenCall itself slow.
 */

/**
 * Everything held, with the age of the answer beside it.
 *
 * The age is not decoration. An SLA figure contains a date, so one drawn from a table that
 * stopped refreshing on Tuesday is not merely out of date — it is confidently wrong, and it
 * looks precisely like a current one. The screen can then say so.
 */
export const listFieldezSlaController: RequestHandler = asyncHandler(
  async (_request, response) => {
    const [records, freshness] = await Promise.all([listAllSla(), getSlaFreshness()]);
    response.json({ data: { records, freshness } });
  },
);

/**
 * The work orders the worker should come back with an SLA for.
 *
 * FieldEZ's own open-ticket list is narrower than the report — it returned four hundred
 * against nine hundred and fifty, and calls four days old sat in the gap with no SLA on
 * screen. This is what the sweep is driven from instead, so anything FieldEZ's list misses
 * is asked for by name.
 */
export const listWantedTicketsController: RequestHandler = asyncHandler(
  async (_request, response) => {
    const ticketNos = await listWantedTicketNumbers();
    response.json({ data: { ticketNos } });
  },
);

interface IncomingSla {
  ticketNo?: unknown;
  caseId?: unknown;
  fieldezTicketId?: unknown;
  bpId?: unknown;
  slaStatus?: unknown;
  slaPolicy?: unknown;
  slaEndTime?: unknown;
  priority?: unknown;
  taskName?: unknown;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Take a sweep's worth of SLA readings.
 *
 * `prune` asks for calls FieldEZ no longer lists to be dropped, and `sweepStartedAt` says
 * from when. It is a flag rather than automatic because it is only safe when the sweep
 * actually completed: a partial sweep looks identical to "every other call closed", and
 * acting on that would empty the table on the first night FieldEZ was slow.
 *
 * The cutoff is a TIMESTAMP and not the list of keys in this request. A sweep arrives in
 * batches; "delete everything not in this request" deleted the two hundred rows written by
 * the batch before it and left the table holding one call. Every row a sweep touches is
 * stamped NOW(), so what it did not touch is exactly what predates its start.
 */
export const importFieldezSlaController: RequestHandler = asyncHandler(
  async (request, response) => {
    const body = request.body as
      | { records?: unknown; prune?: unknown; sweepStartedAt?: unknown }
      | undefined;
    const incoming = body?.records;
    if (!Array.isArray(incoming)) {
      throw badRequest("Expected a `records` array of SLA readings", { field: "records" });
    }

    const records: FieldezSlaRecord[] = [];
    const seen = new Set<string>();
    for (const raw of incoming as IncomingSla[]) {
      const ticketNo = String(raw?.ticketNo ?? "").trim();
      const key = ticketKey(ticketNo);
      // No work order means nothing to attach the reading to, and a duplicate within one
      // payload would make the INSERT's ON CONFLICT fire against its own row — which
      // Postgres refuses outright rather than resolving.
      if (!key || seen.has(key)) continue;
      seen.add(key);
      records.push({
        ticketKey: key,
        ticketNo,
        caseId: String(raw?.caseId ?? "").trim(),
        fieldezTicketId: toNumberOrNull(raw?.fieldezTicketId) ?? 0,
        bpId: toNumberOrNull(raw?.bpId),
        slaStatus: String(raw?.slaStatus ?? "").trim(),
        slaPolicy: String(raw?.slaPolicy ?? "").trim(),
        slaEndTime: parseSlaEndTime(raw?.slaEndTime),
        priority: String(raw?.priority ?? "").trim(),
        taskName: String(raw?.taskName ?? "").trim(),
      });
    }

    const written = await upsertSlaRecords(records);
    let removed = 0;
    // Both conditions matter. Without a cutoff there is nothing to compare against, and
    // pruning on a sweep that did not finish would delete calls that are simply still
    // queued.
    if (body?.prune === true && typeof body.sweepStartedAt === "string") {
      removed = await deleteSlaOlderThan(body.sweepStartedAt);
    }

    response.status(201).json({
      data: { received: incoming.length, written, removed, freshness: await getSlaFreshness() },
    });
  },
);
