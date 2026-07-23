import { env } from "../../config/env.js";
import {
  normalizeRawKey,
  replaceFlexRawRecords,
  type FlexRawRecordInput,
  type FlexRawStatusGroup,
} from "../../repositories/flexRawRecordRepository.js";
import { classifyRawStatus, normalizeMonthKey } from "./flexRawClassify.js";

/**
 * Pulls the Flex raw closed-call rows from the standalone raw-data project's API
 * (FLEX_RAW_API_URL) and replaces the stored raw record set — the API replacement for the
 * old manual Excel upload. The classification and month normalisation happen here, so
 * OpenCall stays the single authority over what "closed" and which month a row belongs to.
 */

export interface FlexRawSyncResult {
  totalRows: number;
  imported: number;
  skippedNoData: number;
  closed: number;
  cancelled: number;
  resolved: number;
  open: number;
  generatedAt: string | null;
}

interface RawApiRow {
  ticketNo?: unknown;
  caseId?: unknown;
  workLocation?: unknown;
  callStatus?: unknown;
  month?: unknown;
}

export function isFlexRawSyncConfigured(): boolean {
  return Boolean(env.FLEX_RAW_API_URL);
}

export async function syncFlexRawDataFromApi(): Promise<FlexRawSyncResult> {
  if (!env.FLEX_RAW_API_URL) {
    throw new Error(
      "Raw data API is not configured. Set FLEX_RAW_API_URL in the backend .env.",
    );
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (env.FLEX_RAW_API_KEY) headers["X-API-Key"] = env.FLEX_RAW_API_KEY;

  let response: Response;
  try {
    response = await fetch(env.FLEX_RAW_API_URL, { headers });
  } catch (error) {
    throw new Error(
      `Could not reach the raw data API at ${env.FLEX_RAW_API_URL}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Raw data API returned ${response.status} ${response.statusText}.`,
    );
  }

  const payload = (await response.json()) as {
    rows?: RawApiRow[];
    generatedAt?: string | null;
  };
  const rows = Array.isArray(payload.rows) ? payload.rows : [];

  const inputs: FlexRawRecordInput[] = [];
  let skippedNoData = 0;
  const tally: Record<FlexRawStatusGroup, number> = {
    closed: 0,
    cancelled: 0,
    resolved: 0,
    open: 0,
  };

  for (const row of rows) {
    const callStatus = String(row.callStatus ?? "").trim();
    const workLocation = normalizeRawKey(row.workLocation);
    const ticketNo = normalizeRawKey(row.ticketNo);
    const caseId = normalizeRawKey(row.caseId);

    if (!callStatus && !workLocation && !ticketNo && !caseId) {
      skippedNoData += 1;
      continue;
    }

    const statusGroup = classifyRawStatus(callStatus);
    tally[statusGroup] += 1;

    inputs.push({
      ticketNo,
      caseId,
      workLocation,
      callStatus,
      statusGroup,
      startDate: null,
      sourceMonth: normalizeMonthKey(row.month),
    });
  }

  const imported = await replaceFlexRawRecords(inputs);

  return {
    totalRows: rows.length,
    imported,
    skippedNoData,
    closed: tally.closed,
    cancelled: tally.cancelled,
    resolved: tally.resolved,
    open: tally.open,
    generatedAt: payload.generatedAt ?? null,
  };
}
