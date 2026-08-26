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

/**
 * Type the work order into "Enter Ticket No", search, and end up on its Details page.
 *
 * Two endings are allowed for, because which one happens is FieldEZ's choice rather than
 * ours: the search may land straight on Ticket ▸ Details, or it may narrow the list to a
 * single row that still has to be clicked. Assuming one of the two would make the scraper
 * work until the day it did the other.
 */
async function openTicket(page: Page, ticketNo: string): Promise<boolean> {
  const box = page.getByPlaceholder(/enter ticket no/i).first();
  await box.waitFor({ state: "visible", timeout: 30000 });
  await box.fill("");
  await box.fill(ticketNo);
  log(`searching for ${ticketNo}…`);
  await box.press("Enter").catch(() => {});
  await page.waitForTimeout(3500);

  if (/ticket-view\/.+\/summary/i.test(page.url())) return true;

  // Still on the list: the search filtered it, so open the one row it left.
  const link = page.getByRole("link", { name: new RegExp(ticketNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
  const fallback = page.locator(`text=${ticketNo}`).first();
  const target = (await link.count()) > 0 ? link : fallback;
  if ((await target.count()) === 0) {
    log(`no row on the list matched ${ticketNo}`);
    return false;
  }
  await target.click({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  return /ticket-view\/.+\/summary/i.test(page.url());
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
  page.on("response", (response) => {
    const url = response.url();
    if (!/\/api\/|\/rest\/|json/i.test(url)) return;
    void response
      .text()
      .then((body) => {
        if (!/sla/i.test(body)) return;
        if (slaResponses.some((r) => r.url === url)) return;
        slaResponses.push({ url, sample: body.slice(0, 600) });
      })
      .catch(() => {
        /* a response whose body is gone tells us nothing */
      });
  });

  try {
    await openSummary(page);
    const landed = await openTicket(page, ticketNo);
    console.log(`\nURL after the search: ${page.url()}`);
    if (!landed) {
      console.log("\nDid NOT reach a Ticket/Details page. Nothing to read.");
      return;
    }

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

    console.log("\nAPI RESPONSES THAT MENTION SLA");
    console.log("-".repeat(74));
    if (slaResponses.length === 0) {
      console.log("  none — the SLA is only in the HTML, so each ticket costs a page load.");
    } else {
      for (const response of slaResponses) {
        console.log(`  ${response.url}`);
        console.log(`    ${response.sample.replace(/\s+/g, " ").slice(0, 400)}`);
      }
      console.log("\n  ^ If one of these carries the SLA, every ticket can be read by calling it");
      console.log("    directly — minutes for all of them instead of an hour.");
    }
  } catch (error) {
    console.error("\nFAILED:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

void run();
