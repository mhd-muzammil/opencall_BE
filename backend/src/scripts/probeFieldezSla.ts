import "dotenv/config";
import path from "node:path";
import { chromium, type Page } from "playwright";

/**
 * Walk one work order through FieldEZ by hand and print what its SLA actually says.
 *
 * The plan is to read the SLA of every open call — around nine hundred of them — and put it
 * beside the call in OpenCall. Every part of that plan rests on one question nobody has
 * answered yet: can this be read reliably at all? The steps are known because a person does
 * them daily — Ticket ▸ Summary, type the work order into "Enter Ticket No", press search,
 * land on Ticket ▸ Details, read the four SLA fields — but "a person can do it" and "a
 * headless browser can do it nine hundred times an hour" are different claims, and building
 * the table, the API and the two screens before testing the first one would be building on a
 * guess.
 *
 * So this does exactly those steps, once, and prints what it found. It writes nothing —
 * no database, no API call, no report.
 *
 * IT ALSO WATCHES THE NETWORK. The details page is drawn by a frontend calling an API, and
 * if that API hands back the SLA as JSON then nine hundred page loads become nine hundred
 * cheap requests, which is the difference between an hourly refresh and a live one. Every
 * response that mentions SLA is reported with its URL, so the fast path can be chosen on
 * evidence rather than assumed either way.
 *
 * ITS OWN BROWSER PROFILE. `launchPersistentContext` takes an exclusive lock on its profile
 * directory, so sharing the sync worker's would crash whichever started second. This keeps
 * its own, which also means its FieldEZ session survives between runs instead of logging in
 * again every time.
 *
 *   node backend/dist/scripts/probeFieldezSla.js WO-035655580
 */

const config = {
  loginUrl: process.env.FIELDEZ_URL ?? "https://prod.fsmsupport.com/frontend/auth/login",
  summaryUrl:
    process.env.FIELDEZ_SUMMARY_URL ?? "https://prod.fsmsupport.com/frontend/tlm/summary-list",
  username: process.env.FIELDEZ_USERNAME ?? "",
  password: process.env.FIELDEZ_PASSWORD ?? "",
  profileDir:
    process.env.FIELDEZ_PROBE_PROFILE_DIR ?? path.resolve("/tmp/fieldez-probe-profile"),
};

/** The four fields the Ticket ▸ Details page shows, plus what frames them. */
const WANTED_LABELS = [
  "Priority",
  "SLA Status",
  "SLA Remaining",
  "Assigned To",
  "SLA Policy",
  "SLA End Time",
  "Schedule Start",
  "Schedule End",
] as const;

function log(msg: string): void {
  console.log(`[probe] ${new Date().toISOString().slice(11, 19)} ${msg}`);
}

/**
 * The value FieldEZ renders under a label.
 *
 * The page is a grid of label-above-value cards, so in the rendered text the value is simply
 * the next line. Read this way rather than by CSS selector on purpose: class names on a
 * frontend that is being actively developed change without warning and take the scraper down
 * silently, whereas the words a person reads on the screen are the last thing to change.
 *
 * An em dash or a bare hyphen is FieldEZ's way of writing "nothing here" — several tickets
 * carry no SLA at all — and that is returned as empty rather than as the character, so
 * nothing downstream mistakes a placeholder for a value.
 */
function valueAfter(lines: readonly string[], label: string): string {
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== label) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = (lines[j] ?? "").trim();
      if (!candidate) continue;
      // The next label, meaning this one had no value under it at all.
      if ((WANTED_LABELS as readonly string[]).includes(candidate)) return "";
      if (candidate === "—" || candidate === "-" || candidate === "–") return "";
      return candidate;
    }
    return "";
  }
  return "";
}

async function login(page: Page): Promise<void> {
  log("logging in…");
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.getByPlaceholder(/user ?name/i).first().fill(config.username, { timeout: 20000 });
  await page.locator('input[type="password"]').first().fill(config.password, { timeout: 20000 });
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {}),
    page.getByRole("button", { name: /log ?in/i }).first().click(),
  ]);
  await page.waitForTimeout(3000);
  if (/auth\/login/i.test(page.url())) {
    throw new Error("login did not leave the login page — check FIELDEZ_USERNAME / PASSWORD");
  }
  log("login OK");
}

/** Ticket ▸ Summary, logging in first if the saved session has lapsed. */
async function openSummary(page: Page): Promise<void> {
  await page.goto(config.summaryUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);
  if (/auth\/login/i.test(page.url())) {
    await login(page);
    await page.goto(config.summaryUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000);
  }
}

/** Every work order the list is currently showing, read off the rendered page. */
async function visibleTickets(page: Page): Promise<string[]> {
  const text = await page.locator("body").innerText({ timeout: 15000 }).catch(() => "");
  return [...new Set(text.match(/WO-?\d{6,}/gi) ?? [])];
}

/**
 * Run the search once, for one spelling of the work order.
 *
 * PRESSING ENTER IS NOT THE SEARCH. The box sits beside its own magnifier button and the
 * first attempt at this typed the work order, pressed Enter, waited, and found the list
 * exactly as it was — the keypress went nowhere. So the button next to the box is clicked,
 * with Enter kept only as a fallback for the day FieldEZ makes the box submit on its own.
 *
 * Reports what the list showed afterwards either way. "No row matched" and "the search
 * never ran" look identical from the outside and need completely different fixes, and the
 * work orders still on screen tell the two apart: unchanged means the search did not fire,
 * empty means it fired and found nothing.
 */
async function trySearch(page: Page, term: string): Promise<boolean> {
  await openSummary(page);
  const box = page.getByPlaceholder(/enter ticket no/i).first();
  await box.waitFor({ state: "visible", timeout: 30000 });
  const before = await visibleTickets(page);

  await box.fill("");
  await box.fill(term);
  log(`searching for "${term}" (list is showing ${before.length} work orders)…`);

  // The button immediately after the box in document order — the magnifier beside it.
  const searchButton = box.locator("xpath=following::button[1]");
  if ((await searchButton.count()) > 0) {
    await searchButton.click({ timeout: 15000 }).catch(() => {});
  } else {
    log("  (no button found after the box — falling back to Enter)");
    await box.press("Enter").catch(() => {});
  }

  // Either the app navigates, or it re-renders the list in place. Wait for the navigation
  // and fall through to the list check when it does not come; 3.5 seconds was simply too
  // short for a page that has to go and ask a server.
  await page
    .waitForURL(/ticket-view\/.+\/summary/i, { timeout: 20000 })
    .catch(() => {});
  if (/ticket-view\/.+\/summary/i.test(page.url())) {
    log("  landed straight on Ticket/Details");
    return true;
  }

  await page.waitForTimeout(2500);
  const after = await visibleTickets(page);
  log(`  still on the list — ${after.length} work order(s) showing: ${after.slice(0, 6).join(", ") || "(none)"}`);
  if (after.length === before.length && after.length > 6) {
    log("  the list did not change, so the search did not actually run");
  }

  const wanted = term.replace(/\D/g, "");
  const match = after.find((t) => t.replace(/\D/g, "") === wanted);
  if (!match) return false;

  log(`  found ${match} on the list — opening it`);
  return openTicketRow(page, match);
}

/**
 * Click the work order on the filtered list and end up on its Details page.
 *
 * `text=WO-…` was the obvious way and it silently did nothing. The trouble with a bare text
 * selector is that it matches the FIRST node containing those characters, which on this page
 * is a wrapper the click passes straight through — and a click that lands on nothing looks
 * exactly like a click that landed and was ignored. The work order is rendered as a link, so
 * the link is what to ask for.
 *
 * Several ways are tried because only FieldEZ knows which one it built, and each is reported
 * as it is attempted: when this breaks again, the log should say which selector stopped
 * matching rather than only that nothing happened.
 */
async function openTicketRow(page: Page, wo: string): Promise<boolean> {
  const escaped = wo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attempts: Array<[string, ReturnType<Page["locator"]>]> = [
    ["role=link", page.getByRole("link", { name: new RegExp(escaped, "i") }).first()],
    ["a:has-text", page.locator(`a:has-text("${wo}")`).first()],
    ["td:has-text", page.locator(`td:has-text("${wo}")`).first()],
    ["any text node", page.getByText(wo, { exact: false }).first()],
  ];

  for (const [name, target] of attempts) {
    const count = await target.count().catch(() => 0);
    if (count === 0) {
      log(`    ${name}: no match`);
      continue;
    }
    const visible = await target.isVisible().catch(() => false);
    log(`    ${name}: found${visible ? "" : " but not visible"} — clicking`);
    await target.click({ timeout: 15000, force: !visible }).catch((error: unknown) => {
      log(`    ${name}: click failed — ${error instanceof Error ? error.message : String(error)}`);
    });
    await page.waitForURL(/ticket-view\/.+\/summary/i, { timeout: 15000 }).catch(() => {});
    if (/ticket-view\/.+\/summary/i.test(page.url())) {
      log(`    ${name}: WORKED`);
      return true;
    }
    log(`    ${name}: still at ${page.url()}`);
  }
  return false;
}

/**
 * Get to the ticket's Details page, trying both ways the work order is written.
 *
 * OpenCall holds `WO-035640797`; whether FieldEZ's box wants that or the bare digits is not
 * something to guess at when asking costs one extra search. Whichever works is reported, so
 * the real scraper is written knowing rather than hoping.
 */
async function openTicket(page: Page, ticketNo: string): Promise<boolean> {
  const digits = ticketNo.replace(/\D/g, "");
  const spellings = digits && digits !== ticketNo ? [ticketNo, digits] : [ticketNo];
  for (const term of spellings) {
    if (await trySearch(page, term)) {
      log(`WORKS with "${term}"`);
      return true;
    }
  }
  return false;
}

/**
 * The record in an API response that is about this work order.
 *
 * Walked rather than read from a known path, because the shape of the response is exactly
 * what is not known yet. Any object holding a string whose digits are the work order's
 * digits is the record — `WO-035640797` and `035640797` are the same ticket written two
 * ways, and which one the API uses is another thing worth finding out rather than assuming.
 */
function findTicketRecord(body: string, ticketNo: string): Record<string, unknown> | null {
  const wanted = ticketNo.replace(/\D/g, "");
  if (!wanted) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const value of Object.values(obj)) {
        if (typeof value === "string" && /\d/.test(value) && value.replace(/\D/g, "") === wanted) {
          return obj;
        }
      }
      stack.push(...Object.values(obj));
    }
  }
  return null;
}

/** Every field of a record that holds a plain number — the id candidates. */
function numericFields(record: Record<string, unknown>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" && Number.isFinite(value)) out.push([key, value]);
    else if (typeof value === "string" && /^\d{1,12}$/.test(value)) out.push([key, Number(value)]);
  }
  return out;
}

async function run(): Promise<void> {
  const ticketNo = (process.argv[2] ?? "").trim();
  if (!ticketNo) {
    console.error("Give it a work order:  node backend/dist/scripts/probeFieldezSla.js WO-035655580");
    process.exitCode = 1;
    return;
  }
  if (!config.username || !config.password) {
    console.error("FIELDEZ_USERNAME / FIELDEZ_PASSWORD are not set on this service.");
    process.exitCode = 1;
    return;
  }

  console.log("=".repeat(74));
  console.log(`FIELDEZ SLA PROBE — ${ticketNo}   (reads only, changes nothing)`);
  console.log("=".repeat(74));

  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // Anything the frontend fetched that mentions SLA. This is the whole reason a cheap,
  // frequent refresh might be possible instead of an hourly crawl.
  const slaResponses: Array<{ url: string; sample: string }> = [];
  /** Every server call the page made, so the ticket endpoint is visible even if its SLA
   *  field happens to be spelled some way this does not grep for. */
  const apiCalls = new Set<string>();
  /**
   * What the ticket API actually returned.
   *
   * Clicking the work order on the list is turning out to be the hard way: it is not a
   * link, and clicking the cell it lives in does nothing a person's click does. But the
   * page found that ticket by asking `POST /tlm/v1.0/ticket/summary-list/search`, and the
   * detail URL is built from two numbers — `/ticket-view/2/1044258/summary`, where 2 looks
   * like the business process and 1044258 like the ticket's own id. Both must be in that
   * response, and if they are then the whole clicking problem disappears: navigate straight
   * to the URL, or skip the browser and call the ticket API directly.
   */
  const ticketApiBodies: Array<{ url: string; body: string }> = [];
  page.on("response", (response) => {
    const url = response.url();
    // Everything except the static assets. Filtering FOR "/api/" assumed a URL shape nobody
    // has checked, and a scraper that misses the one endpoint carrying the SLA because of a
    // guess about its path is the expensive kind of wrong here.
    if (/\.(js|css|png|jpe?g|svg|gif|ico|woff2?|ttf|map)(\?|$)/i.test(url)) return;
    // The translation bundles under /frontend/assets/i18n all contain the word "sla" —
    // "slaType", "slaLabel" — and there are a dozen of them. They are the page's dictionary,
    // not its data, and they buried the two real endpoints on the first run.
    if (/\/frontend\/assets\//i.test(url)) return;
    apiCalls.add(`${response.request().method()} ${url.split("?")[0]}`);
    void response
      .text()
      .then((body) => {
        if (/\/tlm\/v1\.0\/ticket\//i.test(url) && !ticketApiBodies.some((t) => t.url === url)) {
          ticketApiBodies.push({ url, body });
        }
        if (!/sla/i.test(body)) return;
        if (slaResponses.some((r) => r.url === url)) return;
        slaResponses.push({ url, sample: body.slice(0, 600) });
      })
      .catch(() => {
        /* a response whose body is gone tells us nothing */
      });
  });

  try {
    let landed = await openTicket(page, ticketNo);
    console.log(`\nURL after the search: ${page.url()}`);

    // ---- What the search API said, and whether the detail URL can be built from it ----
    console.log("\nWHAT THE TICKET API RETURNED");
    console.log("-".repeat(74));
    let record: Record<string, unknown> | null = null;
    if (ticketApiBodies.length === 0) {
      console.log("  the ticket API was never seen.");
    }
    for (const captured of ticketApiBodies) {
      const found = findTicketRecord(captured.body, ticketNo);
      console.log(`  ${captured.url}`);
      if (!found) {
        console.log(`    no record in it carried ${ticketNo}`);
        continue;
      }
      record = record ?? found;
      console.log(`    fields: ${Object.keys(found).join(", ")}`);
      console.log(`    ${JSON.stringify(found).slice(0, 1400)}`);
    }

    // Clicking the row is proving to be the hard way in. If the record carries the two
    // numbers the detail URL is made of, there is no need to click anything at all — and
    // that is also the shape the real scraper wants, since a URL can be visited nine hundred
    // times without a list page in between.
    if (!landed && record) {
      const numbers = numericFields(record);
      console.log(`\n  numeric fields to build /ticket-view/<a>/<b>/summary from:`);
      for (const [key, value] of numbers) console.log(`    ${key} = ${value}`);

      const big = numbers.filter(([, v]) => v >= 10_000);
      const small = numbers.filter(([, v]) => v > 0 && v < 1000);
      const tried = new Set<string>();
      outer: for (const [idKey, id] of big) {
        for (const [bpKey, bp] of small.length > 0 ? small : ([["guess", 2]] as Array<[string, number]>)) {
          const url = `https://prod.fsmsupport.com/frontend/tlm/ticket-view/${bp}/${id}/summary`;
          if (tried.has(url) || tried.size >= 6) break outer;
          tried.add(url);
          log(`trying ${bpKey}=${bp}, ${idKey}=${id} → ${url}`);
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(3000);
          const text = await page.locator("body").innerText({ timeout: 15000 }).catch(() => "");
          if (text.includes(ticketNo) && /SLA/i.test(text)) {
            log(`  WORKED — the detail URL is /ticket-view/${bpKey}/${idKey}/summary`);
            landed = true;
            break outer;
          }
          log(`  no — that URL did not show ${ticketNo}`);
        }
      }
    }

    if (!landed) {
      console.log("\nDid NOT reach a Ticket/Details page — nothing to read off it.");
    } else {
      // Let the details cards finish drawing; the SLA card fills in after the first paint.
      await page.waitForTimeout(2500);
      const text = await page.locator("body").innerText({ timeout: 20000 });
      const lines = text.split("\n").map((line) => line.trim());

      console.log("\nWHAT THE PAGE SAYS");
      console.log("-".repeat(74));
      for (const label of WANTED_LABELS) {
        const value = valueAfter(lines, label);
        console.log(`  ${label.padEnd(16)} ${value || "(blank)"}`);
      }

      // The raw neighbourhood, so a label that moved can be seen rather than guessed at.
      const firstSla = lines.findIndex((line) => /^SLA /i.test(line));
      if (firstSla >= 0) {
        console.log("\nRAW LINES AROUND THE FIRST SLA LABEL (for when the reading above looks wrong)");
        console.log("-".repeat(74));
        for (const line of lines.slice(Math.max(0, firstSla - 4), firstSla + 16)) {
          console.log(`  |${line}`);
        }
      } else {
        console.log("\nNo line starting with 'SLA' was found on the page at all.");
      }
    }

    console.log("\nEVERY SERVER CALL THE PAGE MADE");
    console.log("-".repeat(74));
    for (const call of [...apiCalls].sort()) console.log(`  ${call}`);

    console.log("\nRESPONSES THAT MENTION SLA");
    console.log("-".repeat(74));
    if (slaResponses.length === 0) {
      console.log("  none — the SLA is only in the HTML, so each ticket costs a page load.");
    } else {
      for (const response of slaResponses) {
        console.log(`  ${response.url}`);
        console.log(`    ${response.sample.replace(/\s+/g, " ").slice(0, 400)}`);
      }
      console.log("\n  ^ If one of these carries this ticket's SLA, every ticket can be read by");
      console.log("    calling it directly — minutes for all of them instead of an hour.");
    }
  } catch (error) {
    console.error("\nFAILED:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

void run();
