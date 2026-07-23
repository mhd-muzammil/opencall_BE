import type { FlexRawStatusGroup } from "../../repositories/flexRawRecordRepository.js";

/**
 * Canonical status classification, mirrored VERBATIM from the raw-data project's
 * `classify_status` (generate_dashboard_data.py) and `classifyStatus` (src/utils/status.ts)
 * so OpenCall can never report a different number than that dashboard:
 *
 *   cancelled : status contains "CANCEL"
 *   closed    : status contains "CLOSED"
 *   resolved  : status contains "RESOLUTION" or "RESOLVED"
 *   open      : everything else (incl. "OPEN", blanks, unknown)
 *
 * The categories are mutually exclusive and exhaustive, so the four always sum to total.
 * Order matters: "CALL CANCELLED" must not be read as closed.
 */
export function classifyRawStatus(callStatus: unknown): FlexRawStatusGroup {
  const s = String(callStatus ?? "").toUpperCase();
  if (s.includes("CANCEL")) return "cancelled";
  if (s.includes("CLOSED")) return "closed";
  if (s.includes("RESOLUTION") || s.includes("RESOLVED")) return "resolved";
  return "open";
}

const MONTH_ABBR: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Normalises the raw export's Month cell to a sortable "YYYY-MM" key.
 * Handles "Jun-26" / "Jul'25" / "Jul 25" / "July 2025"; anything else (incl. "Unknown")
 * becomes '' so it groups under "no month".
 */
export function normalizeMonthKey(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text.toLowerCase() === "unknown") return "";

  const match = /^([A-Za-z]{3,})[\s'\-/]+(\d{2,4})$/.exec(text);
  if (!match) return "";
  const abbr = match[1]!.slice(0, 3).toLowerCase();
  const month = MONTH_ABBR[abbr];
  if (!month) return "";

  let year = match[2]!;
  if (year.length === 2) year = `20${year}`;
  return `${year}-${month}`;
}
