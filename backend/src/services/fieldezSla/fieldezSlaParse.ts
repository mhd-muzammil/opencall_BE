/**
 * Read a FieldEZ ticket's SLA out of what its API returns.
 *
 * Two calls answer this, and the probe established both:
 *
 *   POST /tlm/v1.0/ticket/summary-list        every open ticket — id, work order, bpId
 *   GET  /tlm/v1.0/ticket/{id}                that ticket's SLA
 *
 * The field names are not guessable and were not guessed. FieldEZ spells the same idea
 * three ways in one response — `ft_sla` holds the STATUS ("Within SLA"), `ftSla` holds the
 * POLICY ("Commercial"), and `slaEndTime` holds the deadline — so they are read by name,
 * from evidence, and the near-identical first two are commented here because a future reader
 * will otherwise assume one of them is a typo for the other and "fix" it.
 *
 * THE DEADLINE IS STORED, NOT THE COUNTDOWN. FieldEZ's own screen shows "121h 39m 50s
 * remaining", and copying that would freeze a number that means nothing five minutes later —
 * a page rendered at nine o'clock would still claim 121 hours at noon. `slaEndTime` is a
 * fixed instant, so the countdown is arithmetic anywhere it is needed and is correct at the
 * moment somebody looks. That is what makes this live rather than hourly.
 */

/** One open ticket as the summary-list call describes it. */
export interface FieldezTicketRef {
  /** FieldEZ's own row id — what GET /tlm/v1.0/ticket/{id} wants. */
  fieldezTicketId: number;
  /** The work order as FieldEZ writes it, e.g. WO-035640797. */
  ticketNo: string;
  /** Business process id: 2 is HP Break Fix, 9 is CONS_PRINT_IW. */
  bpId: number | null;
  /** HP's case number, which FieldEZ carries in a generically-named custom field. */
  caseId: string;
  /** Where the ticket has got to — "Partner Parts Hold", "Engineer Assignment Pending". */
  taskName: string;
}

/** A ticket's SLA, as OpenCall stores it. */
export interface FieldezSlaRecord {
  ticketKey: string;
  ticketNo: string;
  caseId: string;
  fieldezTicketId: number;
  bpId: number | null;
  /** "Within SLA", "SLA Breached", or empty when FieldEZ tracks no SLA for this ticket. */
  slaStatus: string;
  /** "Commercial", "Consumer" — which promise applies. Empty when there is none. */
  slaPolicy: string;
  /** The instant the promise expires. Null when the ticket has no SLA. */
  slaEndTime: Date | null;
  priority: string;
  taskName: string;
}

/**
 * The work order reduced to what two spellings share.
 *
 * `WO-035640797` here, `WO035640797` there, `035640797` in a case field — one job written
 * three ways. Everything joins on this rather than on whichever form arrived first.
 */
export function ticketKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  const out = String(value).trim();
  // FieldEZ writes "nothing here" as a dash on screen and sometimes as the string "null".
  if (out === "-" || out === "—" || out === "null" || out === "undefined") return "";
  return out;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * `slaEndTime` as an instant.
 *
 * FieldEZ sends epoch MILLISECONDS — 1788179400000 is 2026-08-31 18:00 IST, which is exactly
 * what its own screen printed for that ticket. Seconds are accepted too, because an API that
 * spells SLA three ways may one day send them, and a 1970 date in the SLA column would be a
 * silent, plausible-looking lie about a deadline that has already passed.
 */
export function parseSlaEndTime(value: unknown): Date | null {
  const raw = toNumber(value);
  if (raw !== null) {
    // Zero is FieldEZ's other way of saying "no deadline", and it must not fall through to
    // the string path below: `new Date("0")` is the year 2000, which would appear in the SLA
    // column as a deadline missed twenty-six years ago. A number that is not a time is not a
    // time, whatever it can be coerced into.
    if (raw <= 0) return null;
    // Anything below this is far too small to be milliseconds since 1970 — it is seconds.
    const ms = raw < 100_000_000_000 ? raw * 1000 : raw;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  // Some responses carry it as a formatted string instead.
  const asText = text(value);
  if (!asText) return null;
  const parsed = new Date(asText);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The tickets in a summary-list response, whatever wrapper FieldEZ put them in. */
export function parseTicketList(payload: unknown): FieldezTicketRef[] {
  const rows = findRows(payload);
  const out: FieldezTicketRef[] = [];
  for (const row of rows) {
    const ticketNo = text(row["ft_ticket_no"]);
    const id = toNumber(row["id"]);
    if (!ticketNo || id === null) continue;
    out.push({
      fieldezTicketId: id,
      ticketNo,
      bpId: toNumber(row["bpId"]),
      // HP's case number rides in a custom slot; the probe found 5163861807 in atrb5 for a
      // ticket whose Case ID is 5163861807.
      caseId: text(row["small_text_atrb5"]),
      taskName: text(row["ftTaskName"]),
    });
  }
  return out;
}

/**
 * The array of ticket rows, wherever it is.
 *
 * The list endpoint has been seen returning a bare array and returning `{data: [...]}`, and
 * paging wrappers tend to grow more layers over time. Rather than hard-code a path that will
 * be wrong after the next FieldEZ release, find the first array whose members look like
 * ticket rows.
 */
function findRows(payload: unknown): Array<Record<string, unknown>> {
  const stack: unknown[] = [payload];
  let depth = 0;
  while (stack.length > 0 && depth < 500) {
    depth += 1;
    const node = stack.shift();
    if (Array.isArray(node)) {
      const rows = node.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item) &&
          "ft_ticket_no" in (item as Record<string, unknown>),
      );
      if (rows.length > 0) return rows;
      stack.push(...node);
      continue;
    }
    if (node && typeof node === "object") stack.push(...Object.values(node));
  }
  return [];
}

/**
 * One ticket's SLA, from the detail response joined to what the list already knew.
 *
 * The list is kept as the authority for the work order and the case id: the detail response
 * carries them too, but under yet another set of names, and there is nothing to gain from
 * reading the same fact twice from two places that can disagree.
 */
export function parseSlaDetail(
  ref: FieldezTicketRef,
  payload: unknown,
): FieldezSlaRecord {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  return {
    ticketKey: ticketKey(ref.ticketNo),
    ticketNo: ref.ticketNo,
    caseId: ref.caseId,
    fieldezTicketId: ref.fieldezTicketId,
    bpId: ref.bpId,
    // ft_sla is the STATUS and ftSla is the POLICY. They are not each other's typo.
    slaStatus: text(record["ft_sla"]),
    slaPolicy: text(record["ftSla"]),
    slaEndTime: parseSlaEndTime(record["slaEndTime"]),
    priority: text(record["ft_priority"]),
    taskName: ref.taskName,
  };
}

/** Whole seconds left on the promise. Negative once it has been missed, null when untracked. */
export function secondsRemaining(slaEndTime: Date | null, now: Date = new Date()): number | null {
  if (!slaEndTime) return null;
  return Math.round((slaEndTime.getTime() - now.getTime()) / 1000);
}

/**
 * "121h 39m 50s", the way FieldEZ writes it.
 *
 * Hours rather than days, because that is the unit the promise is made in and the unit the
 * person chasing it thinks in — "5 days" reads as comfortable in a way "121h" does not.
 */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null) return "";
  const overdue = seconds < 0;
  const total = Math.abs(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return `${overdue ? "-" : ""}${hours}h ${minutes}m ${rest}s`;
}
