// Brands the CRM takes calls for.
//
// HP calls arrive from the Flex WIP file every 15 minutes. Acer calls are typed in
// by a SUPER_ADMIN (pasted from Acer's portal) and kept in brand_calls; the report
// generator adds the open ones to every daily report as ordinary rows, so the
// Records table, engineer assignment, the Payroll engineer app and Engineer
// Productivity all handle them with the same code as HP calls.
//
// A report row's brand is read from its Ticket ID: an Acer row's ticket is
// "ACER-<Acer case id>" (e.g. ACER-1877563C). HP tickets are "WO-…", so the two
// can never collide, the brand survives every carry-forward and closure without
// a new column on the report tables, and the engineer sees "ACER-" on the case
// in the Payroll app.

export type CallBrand = "HP" | "ACER";

export const CALL_BRANDS: readonly CallBrand[] = ["HP", "ACER"];

export const CALL_BRAND_LABELS: Record<CallBrand, string> = {
  HP: "HP",
  ACER: "Acer",
};

export const ACER_TICKET_PREFIX = "ACER-";

/** The report-row Ticket ID for an Acer case id ("1877563C" -> "ACER-1877563C"). */
export function acerTicketIdForCase(caseId: string): string {
  return `${ACER_TICKET_PREFIX}${caseId.trim().toUpperCase()}`;
}

/** Which brand a report row (by its Ticket ID) belongs to. Anything not Acer is HP. */
export function brandForTicketId(ticketId: unknown): CallBrand {
  const text = String(ticketId ?? "").trim().toUpperCase();
  return text.startsWith(ACER_TICKET_PREFIX) ? "ACER" : "HP";
}

export function isAcerTicketId(ticketId: unknown): boolean {
  return brandForTicketId(ticketId) === "ACER";
}
