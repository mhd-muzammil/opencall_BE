import type { Page } from "playwright";
import {
  parseSlaDetail,
  parseTicketList,
  type FieldezSlaRecord,
  type FieldezTicketRef,
} from "../services/fieldezSla/fieldezSlaParse.js";

/**
 * Read every open call's SLA from FieldEZ and hand it to OpenCall.
 *
 * The obvious way to do this is the way a person does it: search for the work order, open
 * its page, read the four SLA fields. That works, and it was proven working — but it is one
 * page load per call, and there are the better part of a thousand. An hour a sweep is not
 * the "live" that was asked for.
 *
 * FieldEZ's own frontend does not work that way either. It asks two endpoints:
 *
 *   POST /tlm/v1.0/ticket/summary-list   {"status":"Open,Scheduled", …}   every open ticket
 *   GET  /tlm/v1.0/ticket/{id}                                            that ticket's SLA
 *
 * so this asks the same two. A list call and a thousand small JSON reads is minutes, not an
 * hour, and nothing is scraped: `ft_sla`, `ftSla` and `slaEndTime` are read by name from
 * fields the probe found rather than lifted out of rendered HTML that changes with the next
 * release.
 *
 * THE SESSION IS THE BROWSER'S. The worker already holds a logged-in FieldEZ page, and
 * `page.request` shares its cookies. Whatever else the app sends to authenticate — a bearer
 * token, an org header — is copied off a real request it makes rather than guessed at, so
 * this keeps working if FieldEZ changes how it authenticates.
 */

export interface SlaSyncResult {
  listed: number;
  read: number;
  failed: number;
  pushed: number;
  /** True only when every ticket was read, which is what makes pruning safe. */
  complete: boolean;
  error?: string;
}

/** Tickets read at once. Enough to be quick, few enough not to look like an attack. */
const CONCURRENCY = Number(process.env.FIELDEZ_SLA_CONCURRENCY ?? 6) || 6;

/** Records per POST to OpenCall. A thousand rows in one body is a needless spike. */
const PUSH_BATCH = Number(process.env.FIELDEZ_SLA_PUSH_BATCH ?? 200) || 200;

/**
 * Tickets per page of the list.
 *
 * Asking for all of them at once looked like the obvious saving and was rejected outright:
 * `rows=5000` came back 400 on every cycle. FieldEZ's own frontend asks for twenty, so the
 * endpoint has a ceiling somewhere between, and guessing where it is costs a whole cycle
 * per guess. A hundred at a time is ten requests for a thousand calls — nothing next to the
 * thousand detail reads that follow — and `FALLBACK_ROWS` is the size known to work, used
 * automatically if even this is refused.
 */
const LIST_ROWS = Number(process.env.FIELDEZ_SLA_LIST_ROWS ?? 100) || 100;

/** The page size FieldEZ's own frontend uses, so it is certainly accepted. */
const FALLBACK_ROWS = 20;

/** A runaway guard: a hundred pages is ten thousand tickets, far past anything real. */
const MAX_PAGES = 100;

/** The statuses that count as an open call — the same ones FieldEZ's own list asks for. */
const OPEN_STATUS = process.env.FIELDEZ_SLA_STATUS ?? "Open,Scheduled";

/**
 * The headers FieldEZ's frontend sends with its API calls.
 *
 * Copied from a real request rather than assumed. Cookies come along on their own because
 * `page.request` shares the browser context, but an app that also sends a bearer token would
 * get a 401 from a hand-built request and the failure would look like "no tickets today".
 */
async function captureAuthHeaders(
  page: Page,
  base: string,
  log: (message: string) => void,
): Promise<Record<string, string>> {
  const wanted = [
    "authorization",
    "x-auth-token",
    "x-access-token",
    "token",
    "orgid",
    "x-org-id",
    "x-tenant-id",
  ];
  let captured: Record<string, string> | null = null;

  const onRequest = (request: { url: () => string; headers: () => Record<string, string> }) => {
    if (captured) return;
    if (!/\/(tlm|admin|dashboard)\/v1\.0\//i.test(request.url())) return;
    const headers = request.headers();
    const picked: Record<string, string> = {};
    for (const name of wanted) {
      const value = headers[name];
      if (value) picked[name] = value;
    }
    captured = picked;
  };

  page.on("request", onRequest);
  try {
    await page.goto(`${base}/frontend/tlm/summary-list`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(5000);
  } finally {
    page.off("request", onRequest);
  }

  const headers = captured ?? {};
  log(
    Object.keys(headers).length > 0
      ? `auth headers copied: ${Object.keys(headers).join(", ")}`
      : "no auth headers on FieldEZ's own calls — relying on cookies alone",
  );
  return headers;
}

/** One page of the open-ticket list. Throws with the server's own words on a refusal. */
async function fetchTicketPage(
  page: Page,
  base: string,
  headers: Record<string, string>,
  pageIndex: number,
  rows: number,
): Promise<FieldezTicketRef[]> {
  const response = await page.request.post(
    `${base}/tlm/v1.0/ticket/summary-list?page=${pageIndex}&rows=${rows}`,
    {
      headers: { ...headers, "Content-Type": "application/json" },
      // Exactly the body FieldEZ's own frontend sends. Copied from a captured request, not
      // reasoned out — a field guessed wrong here is a 400 with no explanation.
      data: {
        status: OPEN_STATUS,
        tasks: "",
        location: "",
        bpId: "",
        startDate: "",
        endDate: "",
        isLink: false,
        isPart: null,
      },
      timeout: 120_000,
    },
  );
  if (!response.ok()) {
    // The status alone said "400" for two cycles and nothing about why. The body usually
    // names the field it did not like, which is the difference between a fix and a guess.
    const detail = (await response.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
    throw new Error(
      `summary-list returned ${response.status()} for page=${pageIndex} rows=${rows}` +
        (detail ? ` — ${detail}` : ""),
    );
  }
  return parseTicketList(await response.json().catch(() => null));
}

/**
 * Every open ticket FieldEZ knows about, a page at a time.
 *
 * One call for the lot was the first attempt and FieldEZ refused it — `rows=5000` returned
 * 400 every cycle. Paging is what the endpoint is built for, and it costs ten requests
 * against the thousand detail reads that follow.
 *
 * If even the configured page size is refused, it drops to the twenty FieldEZ's own frontend
 * asks for and carries on. A ceiling that moves with the next release should cost a slower
 * sweep, not a dead one.
 */
async function listOpenTickets(
  page: Page,
  base: string,
  headers: Record<string, string>,
  log: (message: string) => void,
): Promise<FieldezTicketRef[]> {
  let rows = LIST_ROWS;
  const all: FieldezTicketRef[] = [];
  const seen = new Set<number>();

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    let batch: FieldezTicketRef[];
    try {
      batch = await fetchTicketPage(page, base, headers, pageIndex, rows);
    } catch (error) {
      if (pageIndex === 0 && rows !== FALLBACK_ROWS) {
        log(
          `${error instanceof Error ? error.message : String(error)} — retrying at ${FALLBACK_ROWS} per page`,
        );
        rows = FALLBACK_ROWS;
        pageIndex -= 1;
        continue;
      }
      throw error;
    }

    // A page that repeats what the last one held means the endpoint is ignoring `page`, and
    // continuing would loop until MAX_PAGES collecting the same twenty tickets.
    const fresh = batch.filter((ticket) => !seen.has(ticket.fieldezTicketId));
    for (const ticket of fresh) seen.add(ticket.fieldezTicketId);
    all.push(...fresh);

    if (batch.length < rows || fresh.length === 0) break;
  }
  return all;
}

/** One ticket's SLA. Returns null when FieldEZ would not answer for it. */
async function readSla(
  page: Page,
  base: string,
  headers: Record<string, string>,
  ref: FieldezTicketRef,
): Promise<FieldezSlaRecord | null> {
  try {
    const response = await page.request.get(`${base}/tlm/v1.0/ticket/${ref.fieldezTicketId}`, {
      headers,
      timeout: 45_000,
    });
    if (!response.ok()) return null;
    return parseSlaDetail(ref, await response.json().catch(() => null));
  } catch {
    // One ticket failing is one ticket; the sweep is not abandoned for it. It is counted,
    // and a count above zero is what stops the pruning step running on a partial picture.
    return null;
  }
}

/**
 * Run `worker` over `items`, `limit` at a time.
 *
 * Deliberately not Promise.all over the lot: a thousand simultaneous requests is how a
 * partner integration gets its IP blocked, and a blocked IP takes the report sync down with
 * it — the same browser, the same login.
 */
async function inPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface SlaSyncOptions {
  page: Page;
  /** FieldEZ origin, e.g. https://prod.fsmsupport.com */
  fieldezBase: string;
  /** OpenCall API base, e.g. http://opencall:4000 */
  apiUrl: string;
  /** Sends one batch to OpenCall. Given as a function so the worker keeps its token logic. */
  push: (records: readonly FieldezSlaRecord[], prune: boolean) => Promise<number>;
  log: (message: string) => void;
}

export async function runFieldezSlaSync(options: SlaSyncOptions): Promise<SlaSyncResult> {
  const { page, fieldezBase, push, log } = options;
  const result: SlaSyncResult = { listed: 0, read: 0, failed: 0, pushed: 0, complete: false };

  const headers = await captureAuthHeaders(page, fieldezBase, log);

  const tickets = await listOpenTickets(page, fieldezBase, headers, log);
  result.listed = tickets.length;
  if (tickets.length === 0) {
    // Not "every call closed". A list that comes back empty is far more likely to be a
    // lapsed session or a bad night at FieldEZ, and acting on it would wipe the table.
    result.error = "the open-ticket list came back empty — not writing anything";
    log(result.error);
    return result;
  }
  log(`${tickets.length} open ticket(s) listed — reading their SLA…`);

  const records = (await inPool(tickets, CONCURRENCY, (ref) => readSla(page, fieldezBase, headers, ref)))
    .filter((record): record is FieldezSlaRecord => record !== null);
  result.read = records.length;
  result.failed = tickets.length - records.length;
  result.complete = result.failed === 0;

  for (let index = 0; index < records.length; index += PUSH_BATCH) {
    const batch = records.slice(index, index + PUSH_BATCH);
    const last = index + PUSH_BATCH >= records.length;
    // Pruning only on a complete sweep, and only with the last batch — the API compares
    // against what it was just given, so pruning mid-way would delete the rows still queued.
    result.pushed += await push(batch, last && result.complete);
  }

  log(
    `SLA sync done — listed ${result.listed}, read ${result.read}, ` +
      `${result.failed} unreadable, ${result.pushed} stored` +
      (result.complete ? "" : " (partial, so nothing was pruned)"),
  );
  return result;
}
