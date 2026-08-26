import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { runFieldezSlaSync } from "./fieldezSlaJob.js";

/**
 * Standalone worker that mirrors the manual "download a report from FieldEZ → send it to
 * OpenCall" steps, on a timer. It runs TWO jobs:
 *
 *   wip      every 15 min — Flex WIP Report ASP     → POST /uploads, then generate
 *   closure  every 60 min — Flex Closure ASP Report → POST /closure-dates/import (merge)
 *
 * ONE process, ONE browser, ONE profile. `chromium.launchPersistentContext` takes an
 * exclusive lock on its user-data directory, so a second container sharing the profile
 * volume would crash-loop — and giving it its own profile would mean a second concurrent
 * FieldEZ login. The jobs therefore run strictly sequentially on the same `Page`.
 *
 * Each job keeps its own hash file: a shared one would make the two clobber each other
 * and each would re-upload every cycle.
 *
 * Like the warranty worker, this is the ONLY process that drives a browser; it runs on
 * its own (see the `fieldez:worker` npm script). All secrets come from env.
 */

function str(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}
function num(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const config = {
  loginUrl: str("FIELDEZ_URL", "https://prod.fsmsupport.com/frontend/auth/login"),
  reportsUrl: str("FIELDEZ_REPORTS_URL", "https://prod.fsmsupport.com/frontend/birt/viewlist"),
  username: str("FIELDEZ_USERNAME"),
  password: str("FIELDEZ_PASSWORD"),
  reportName: str("FIELDEZ_REPORT_NAME", "Flex WIP Report ASP"),
  // Folder path to walk before looking for a report row, "A>B" for A ▸ B. FieldEZ
  // reorganised /birt/viewlist into folders on 2026-08-21 and the page now lands on an
  // empty list, so the reports have to be navigated to. Configurable because the next
  // reorganisation should cost an env var, not a deploy.
  reportFolderPath: str("FIELDEZ_REPORT_FOLDER_PATH", "REPORTS>OTB REPORT")
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean),
  format: str("FIELDEZ_FORMAT", "XLSX"),
  profileDir: str("FIELDEZ_PROFILE_DIR", path.resolve(".fieldez-profile")),
  intervalMs: num("FIELDEZ_SYNC_INTERVAL_MS", 15 * 60 * 1000), // 15 min default
  // Closure report. Blank report name ⇒ the closure job is never scheduled, so a deploy
  // that does not set these behaves exactly as before.
  closureReportName: str("FIELDEZ_CLOSURE_REPORT_NAME"),
  // Matches the WIP job's cadence. The closure report demonstrably changes well
  // inside an hour, so a slower poll just serves stale reconciliation numbers.
  closureIntervalMs: num("FIELDEZ_CLOSURE_INTERVAL_MS", 15 * 60 * 1000), // 15 min
  closureDateMode: str("FIELDEZ_CLOSURE_DATE_MODE", "today"),
  // FieldEZ SLA. Unlike the two above this downloads no report: it asks FieldEZ's own API
  // what it promised about each open call and hands the answers to OpenCall. Same cadence as
  // the report jobs, and `FIELDEZ_SLA_ENABLED=false` turns it off without a code change.
  slaEnabled: (process.env.FIELDEZ_SLA_ENABLED ?? "true").trim().toLowerCase() !== "false",
  slaIntervalMs: num("FIELDEZ_SLA_INTERVAL_MS", 15 * 60 * 1000), // 15 min
  fieldezBase: str("FIELDEZ_BASE_URL", "https://prod.fsmsupport.com").replace(/\/$/, ""),
  // Pause between two jobs that came due in the same cycle, so the second one does
  // not hit the API while the first one's report generation is still finishing.
  jobStaggerMs: num("FIELDEZ_JOB_STAGGER_MS", 60 * 1000),
  // OpenCall target
  apiUrl: str("OPENCALL_API_URL", "http://localhost:4000").replace(/\/$/, ""),
  token: str("OPENCALL_TOKEN"),
  ocUser: str("OPENCALL_USERNAME"),
  ocPass: str("OPENCALL_PASSWORD"),
  regionId: str("OPENCALL_REGION_ID"),
  // How many cycles may fail back-to-back before the process gives up and exits, so
  // the container's restart policy hands the work to a brand-new one. Three cycles is
  // ~45 min at the default interval — long enough to ride out a FieldEZ blip, short
  // enough that a wedged worker does not quietly lose a whole afternoon.
  maxConsecutiveFailures: num("FIELDEZ_MAX_CONSECUTIVE_FAILURES", 3),
};

let isShuttingDown = false;
const shutdown = new AbortController();

function log(msg: string): void {
  console.log(`[fieldez] ${new Date().toISOString()} ${msg}`);
}

function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (shutdown.signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      shutdown.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    shutdown.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Today (IST) as YYYY-MM-DD — the report date the generate step stamps. */
function istTodayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ------------------------------------------------------------------ FieldEZ

async function login(page: Page): Promise<void> {
  log("logging in to FieldEZ…");
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.getByPlaceholder(/user ?name/i).first().fill(config.username, { timeout: 20000 });
  await page.locator('input[type="password"]').first().fill(config.password, { timeout: 20000 });
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {}),
    page.getByRole("button", { name: /log ?in/i }).first().click(),
  ]);
  await page.waitForTimeout(3000);
  if (/auth\/login/i.test(page.url())) {
    throw new Error("login did not leave the login page — check credentials");
  }
  log("login OK");
}

/** Navigate to the reports list; if the session lapsed, log in and retry. */
async function ensureReportsPage(page: Page): Promise<void> {
  await page.goto(config.reportsUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);
  if (/auth\/login/i.test(page.url())) {
    await login(page);
    await page.goto(config.reportsUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000);
  }
}

/**
 * The Download Report modal's format picker. Scoped by its own options rather than by
 * position: it happens to be the only <select> today, but if FieldEZ ever adds a
 * parameter dropdown, `select.first()` would silently start driving the wrong control.
 */
async function findFormatSelect(page: Page): Promise<Locator> {
  const selects = page.locator("select");
  await selects.first().waitFor({ state: "visible", timeout: 15000 });
  const count = await selects.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = selects.nth(index);
    const options = await candidate.locator("option").allTextContents();
    if (options.some((text) => /choose format|xlsx|xls\b|pdf|csv/i.test(text))) {
      return candidate;
    }
  }
  return selects.first();
}

/**
 * Puts a date into one of the modal's From/To fields.
 *
 * These are ng-bootstrap datepickers rendered with the `readonly` attribute:
 *
 *   <input readonly ngbdatepicker placeholder="yyyy-mm-dd" class="form-control …">
 *
 * so Playwright's `fill()` refuses them outright ("element is not editable") and the
 * whole closure job died on the first cycle. Opening the calendar and clicking a day
 * would mean driving month navigation, which is far more fragile.
 *
 * Instead the value is set through the native `value` setter and an `input` event is
 * dispatched — which is exactly what NgbInputDatepicker's `manualDateChange` host
 * listener consumes, and its default parser is ISO `yyyy-mm-dd`, the very format the
 * placeholder advertises. `readonly` is dropped first so the field also accepts a
 * normal fill if FieldEZ ever makes these editable.
 *
 * Returns the value the field ended up holding, so the caller can verify it.
 */
async function setDateField(input: Locator, value: string): Promise<string> {
  if (await input.isEditable().catch(() => false)) {
    await input.fill(value, { timeout: 10000 });
  } else {
    await input.evaluate((el, target) => {
      const field = el as HTMLInputElement;
      field.removeAttribute("readonly");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(field, target);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  }

  // Blur rather than pressing Escape: a focused field can leave the calendar overlay
  // covering the Download button, and Escape would close the whole modal.
  await input.evaluate((el) => (el as HTMLElement).blur());
  return (await input.inputValue().catch(() => "")).trim();
}

/**
 * Fills the modal's From/To date fields when the caller supplied dates AND the dialog
 * actually has them. The WIP report takes no parameters; the closure report requires
 * both (red asterisks).
 *
 * Returns how many fields were populated, so a required-date dialog we failed to fill
 * fails loudly instead of downloading the wrong range.
 */
async function fillDateRange(
  page: Page,
  fromDate: string,
  toDate: string,
): Promise<number> {
  if (!fromDate && !toDate) return 0;

  const dateInputs = page.locator('input[placeholder*="yyyy-mm-dd" i]');
  const count = await dateInputs.count();
  if (count === 0) return 0;

  const values = [fromDate, toDate];
  const labels = ["From Date", "To Date"];
  let filled = 0;
  for (let index = 0; index < Math.min(count, values.length); index += 1) {
    const value = values[index];
    if (!value) continue;
    const input = dateInputs.nth(index);
    const actual = await setDateField(input, value);

    if (!actual) {
      throw new Error(
        `${labels[index] ?? `date field ${index}`} stayed empty after setting "${value}"`,
      );
    }
    if (actual !== value) {
      // Not fatal — the widget may reformat — but the range we actually asked for
      // must be visible in the logs, not inferred.
      log(`[closure] ⚠️ ${labels[index]} shows "${actual}" after setting "${value}"`);
    }
    filled += 1;
  }
  return filled;
}

export interface DownloadOptions {
  reportName: string;
  format: string;
  /** YYYY-MM-DD; both blank for a report whose dialog has no date fields. */
  fromDate?: string;
  toDate?: string;
  /** Base file name (no extension) so two jobs never overwrite each other's download. */
  destBaseName: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function reportRowVisible(page: Page, reportName: string): Promise<boolean> {
  return page
    .locator("tr", { hasText: reportName })
    .first()
    .isVisible()
    .catch(() => false);
}

/** What the list actually shows, so a miss reports evidence instead of a bare timeout. */
async function visibleRowLabels(page: Page): Promise<string[]> {
  const rows = await page.locator("table tr").allTextContents().catch(() => []);
  return rows
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 25);
}

/**
 * Every folder label the tree is showing. Matched by the folder icon rather than by
 * position or class name: the labels are the one thing FieldEZ is guaranteed to render,
 * and the icon is what marks an entry as a folder at all.
 */
async function folderLabels(page: Page): Promise<string[]> {
  const icons = page.locator('i[class*="folder" i], span[class*="folder" i]');
  const count = Math.min(await icons.count().catch(() => 0), 40);
  const labels: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const text = (await icons.nth(index).locator("xpath=..").innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    if (text && text.length <= 60 && !labels.includes(text)) labels.push(text);
  }
  return labels;
}

/**
 * Click one folder label; true if the report row appeared as a result.
 *
 * The label is matched case-insensitively because these are rendered uppercase and CSS
 * may be doing that, and every visible match is tried in turn — the sidebar carries a
 * "Reports" link of its own, and guessing which node is the folder is worse than simply
 * trying each and checking. A click that navigates off the list is undone.
 */
async function tryFolder(page: Page, label: string, reportName: string): Promise<boolean> {
  const matches = page.getByText(new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, "i"));
  const count = Math.min(await matches.count().catch(() => 0), 8);
  for (let index = 0; index < count; index += 1) {
    const entry = matches.nth(index);
    if (!(await entry.isVisible().catch(() => false))) continue;
    await entry.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);
    if (!/birt\/viewlist/i.test(page.url())) {
      await ensureReportsPage(page).catch(() => {});
      continue;
    }
    if (await reportRowVisible(page, reportName)) return true;
  }
  return false;
}

/**
 * Bring the report's row on screen. Until 2026-08-21 the list arrived flat and this was
 * a no-op; that day FieldEZ moved the reports into folders (REPORTS ▸ OTB REPORT) and
 * the landing view became an empty list, which stopped both jobs dead at 12:17 IST.
 *
 * The configured path is tried first, then every folder the tree offers — so a report
 * that moves again is found anyway, and the log says where it ended up.
 */
async function revealReport(page: Page, reportName: string): Promise<void> {
  if (await reportRowVisible(page, reportName)) return;

  const tried: string[] = [];
  for (const label of config.reportFolderPath) {
    tried.push(label);
    if (await tryFolder(page, label, reportName)) return;
  }

  for (const label of await folderLabels(page)) {
    if (tried.some((seen) => seen.toLowerCase() === label.toLowerCase())) continue;
    tried.push(label);
    if (await tryFolder(page, label, reportName)) {
      log(`found "${reportName}" under "${label}" — set FIELDEZ_REPORT_FOLDER_PATH to match`);
      return;
    }
  }

  throw new Error(
    `"${reportName}" is not on the reports list. Folders tried: ${tried.join(", ") || "none"}. ` +
      `Rows on screen: ${(await visibleRowLabels(page)).join(" | ") || "(none)"}`,
  );
}

/** Download one report; returns the saved file path. */
async function downloadReport(page: Page, options: DownloadOptions): Promise<string> {
  await revealReport(page, options.reportName);
  const row = page.locator("tr", { hasText: options.reportName }).first();
  await row.waitFor({ state: "visible", timeout: 30000 });
  await row.locator("i.fa-download").first().click({ timeout: 10000 });
  await page.waitForTimeout(1200);

  const wantsDates = Boolean(options.fromDate || options.toDate);
  const filled = await fillDateRange(page, options.fromDate ?? "", options.toDate ?? "");
  if (wantsDates && filled === 0) {
    throw new Error(
      `"${options.reportName}" needs a date range but its dialog exposed no yyyy-mm-dd fields`,
    );
  }

  const select = await findFormatSelect(page);
  await select.selectOption({ label: options.format });

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120000 }),
    page.getByRole("button", { name: /^download$/i }).first().click({ timeout: 10000 }),
  ]);
  const dest = path.join(
    config.profileDir,
    `${options.destBaseName}.${options.format.toLowerCase()}`,
  );
  await download.saveAs(dest);
  return dest;
}

// ----------------------------------------------------------------- OpenCall

let cachedToken = config.token;

async function getToken(force = false): Promise<string> {
  if (cachedToken && !force) return cachedToken;
  if (!config.ocUser || !config.ocPass) {
    if (cachedToken) return cachedToken;
    throw new Error("no OPENCALL_TOKEN and no OPENCALL_USERNAME/PASSWORD to log in with");
  }
  const res = await fetch(`${config.apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: config.ocUser, password: config.ocPass }),
  });
  if (!res.ok) throw new Error(`OpenCall login failed: ${res.status}`);
  const body = (await res.json()) as { data?: { token?: string } };
  cachedToken = body.data?.token ?? "";
  if (!cachedToken) throw new Error("OpenCall login returned no token");
  return cachedToken;
}

/** POST with the cached token, refreshing it once if the API says it expired. */
async function postWithToken(
  send: (token: string) => Promise<Response>,
): Promise<Response> {
  const res = await send(await getToken());
  if (res.status !== 401) return res;
  return send(await getToken(true));
}

interface UploadOutcome {
  status: number;
  batchStatus?: string | undefined;
  rowCount?: number | undefined;
  errorCount?: number | undefined;
  flexBatchId?: string | undefined;
}

async function uploadToOpenCall(filePath: string): Promise<UploadOutcome> {
  const buf = readFileSync(filePath);
  const res = await postWithToken((token) => {
    const fd = new FormData();
    fd.append("flexWipReport", new Blob([buf]), path.basename(filePath));
    if (config.regionId) fd.append("regionId", config.regionId);
    return fetch(`${config.apiUrl}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
  });

  const body = (await res.json().catch(() => null)) as
    | { data?: { batches?: Array<{ id?: string; sourceType?: string; status?: string; rowCount?: number; errorCount?: number }> } }
    | null;
  const b =
    body?.data?.batches?.find((x) => x.sourceType === "FLEX_WIP") ??
    body?.data?.batches?.[0];
  return {
    status: res.status,
    batchStatus: b?.status,
    rowCount: b?.rowCount,
    errorCount: b?.errorCount,
    flexBatchId: b?.id,
  };
}

interface ClosureImportOutcome {
  status: number;
  totalRows?: number | undefined;
  workOrders?: number | undefined;
  imported?: number | undefined;
  withoutClosureDate?: number | undefined;
  /** The server's own message on a non-2xx, so a failure is diagnosable from these logs. */
  error?: string | undefined;
}

/**
 * The most useful one-line description of a failed response: the API's
 * `{ error: { message } }` when it sent one, otherwise the raw body, truncated.
 */
function describeFailure(raw: string, body: unknown): string {
  const message = (body as { error?: { message?: string } } | null)?.error?.message;
  if (message) return message;
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat || "no response body";
}

/**
 * Send the closure workbook to the merge import. `mode=merge` is what stops a today-only
 * download from wiping every earlier day — the default `replace` runs an unconditional
 * DELETE of the whole table.
 */
async function importClosureToOpenCall(filePath: string): Promise<ClosureImportOutcome> {
  const buf = readFileSync(filePath);
  const res = await postWithToken((token) => {
    const fd = new FormData();
    fd.append("mode", "merge");
    fd.append("source", "AUTO");
    fd.append("closureReport", new Blob([buf]), path.basename(filePath));
    return fetch(`${config.apiUrl}/api/v1/closure-dates/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
  });

  // Read as text first: a 500 from the API is often an HTML error page or a plain
  // message, and `res.json()` would swallow it into `null` — which is exactly why the
  // first real failure logged only "import returned 500" and told us nothing.
  const raw = await res.text().catch(() => "");
  let body: {
    data?: {
      totalRows?: number;
      workOrders?: number;
      imported?: number;
      withoutClosureDate?: number;
    };
  } | null = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }

  return {
    status: res.status,
    totalRows: body?.data?.totalRows,
    workOrders: body?.data?.workOrders,
    imported: body?.data?.imported,
    withoutClosureDate: body?.data?.withoutClosureDate,
    error: res.ok ? undefined : describeFailure(raw, body),
  };
}

/** Generate the daily call plan report from the freshly-uploaded Flex WIP batch. */
async function generateReport(
  flexBatchId: string,
): Promise<{ status: number; totalRows?: number | undefined }> {
  const res = await postWithToken((token) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (config.regionId) headers["x-region-id"] = config.regionId;
    return fetch(`${config.apiUrl}/api/v1/reports/daily-call-plan/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        reportDate: istTodayIso(),
        flexUploadBatchId: flexBatchId,
        renderwaysUploadBatchId: null,
        callPlanUploadBatchId: null,
      }),
    });
  });
  const body = (await res.json().catch(() => null)) as { data?: { totalRows?: number } } | null;
  return { status: res.status, totalRows: body?.data?.totalRows };
}

// -------------------------------------------------------------------- cycle

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const hashPath = (jobKey: string) => path.join(config.profileDir, `last-${jobKey}.hash`);

/** The pre-two-job hash file. Read once so the first cycle after deploy is a no-op. */
const LEGACY_WIP_HASH_PATH = () => path.join(config.profileDir, "last-uploaded.hash");

function readLastHash(jobKey: string): string {
  const candidates =
    jobKey === "wip" ? [hashPath(jobKey), LEGACY_WIP_HASH_PATH()] : [hashPath(jobKey)];
  for (const file of candidates) {
    try {
      if (existsSync(file)) return readFileSync(file, "utf8").trim();
    } catch {
      /* fall through to the next candidate */
    }
  }
  return "";
}

function writeLastHash(jobKey: string, hash: string): void {
  try {
    writeFileSync(hashPath(jobKey), hash, "utf8");
  } catch {
    /* best effort */
  }
}

async function syncWip(page: Page): Promise<void> {
  const file = await downloadReport(page, {
    reportName: config.reportName,
    format: config.format,
    destBaseName: "flexwip-latest",
  });
  const hash = hashFile(file);

  if (hash === readLastHash("wip")) {
    log("[wip] report unchanged since last upload — skipping.");
    return;
  }

  log("[wip] report changed — uploading to OpenCall…");
  const out = await uploadToOpenCall(file);
  if (out.status !== 201 && out.status !== 200) {
    log(`[wip] ⚠️ upload returned ${out.status} (${out.batchStatus ?? "?"}, errors=${out.errorCount ?? "?"}) — will retry next cycle`);
    return;
  }
  log(`[wip] uploaded (${out.batchStatus}, ${out.rowCount} rows, ${out.errorCount} errors) — generating report…`);

  if (!out.flexBatchId) {
    log("[wip] ⚠️ no flex batch id in upload response — cannot generate; will retry next cycle");
    return;
  }
  const gen = await generateReport(out.flexBatchId);
  if (gen.status === 201 || gen.status === 200) {
    writeLastHash("wip", hash); // only mark done once the report is actually generated
    log(`[wip] ✅ report generated (${gen.totalRows ?? "?"} rows)`);
  } else {
    log(`[wip] ⚠️ generate returned ${gen.status} — will retry next cycle`);
  }
}

async function syncClosure(page: Page): Promise<void> {
  // Only "today" is supported; the setting exists so a future range mode has a home.
  if (config.closureDateMode !== "today") {
    log(`[closure] unknown FIELDEZ_CLOSURE_DATE_MODE="${config.closureDateMode}" — using today`);
  }
  const today = istTodayIso();

  const file = await downloadReport(page, {
    reportName: config.closureReportName,
    format: config.format,
    fromDate: today,
    toDate: today,
    destBaseName: "flexclosure-latest",
  });
  const hash = hashFile(file);
  const unchanged = hash === readLastHash("closure");

  // Import even when the file is unchanged. The import call is what stamps the
  // sync as alive (closure_sync_runs); skipping identical files froze the
  // freshness badge at the previous successful data import, so every quiet
  // morning — and a genuinely dead worker — both read "stale". The file is one
  // day's closures (a few dozen work orders), so the redundant merge is cheap.
  //
  // The byte size distinguishes a real workbook from an error page or an empty
  // export, which is the other way this import can fail with a server error.
  const bytes = statSync(file).size;
  log(
    `[closure] report ${unchanged ? "unchanged" : "changed"} (${today}, ${bytes} bytes)` +
      ` — importing to OpenCall…`,
  );

  const out = await importClosureToOpenCall(file);
  if (out.status !== 201 && out.status !== 200) {
    log(
      `[closure] ⚠️ import returned ${out.status}: ${out.error ?? "no detail"}` +
        ` — will retry next cycle`,
    );
    return;
  }

  writeLastHash("closure", hash);
  log(
    `[closure] ✅ imported ${out.imported ?? "?"} work orders ` +
      `from ${out.totalRows ?? "?"} file rows ` +
      `(${out.withoutClosureDate ?? 0} with no closure date). ` +
      `No report generation — the overlay applies at serve time.`,
  );
}

/**
 * Every open call's SLA, from FieldEZ's API rather than its pages.
 *
 * The reading and the batching live in fieldezSlaJob.ts; what stays here is the one thing
 * that belongs to this file — talking to OpenCall with the token it already manages and
 * refreshes. `postWithToken` retries once on an expired token, which a job running every
 * fifteen minutes for weeks will eventually need.
 */
async function syncSla(livePage: Page): Promise<void> {
  const outcome = await runFieldezSlaSync({
    page: livePage,
    fieldezBase: config.fieldezBase,
    apiUrl: config.apiUrl,
    log: (message: string) => log(`[sla] ${message}`),
    push: async (records, prune) => {
      const res = await postWithToken((token) =>
        fetch(`${config.apiUrl}/api/v1/fieldez-sla/import`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prune,
            records: records.map((record) => ({
              ticketNo: record.ticketNo,
              caseId: record.caseId,
              fieldezTicketId: record.fieldezTicketId,
              bpId: record.bpId,
              slaStatus: record.slaStatus,
              slaPolicy: record.slaPolicy,
              // ISO over the wire; the API parses either that or the raw epoch.
              slaEndTime: record.slaEndTime ? record.slaEndTime.toISOString() : null,
              priority: record.priority,
              taskName: record.taskName,
            })),
          }),
        }),
      );
      if (!res.ok) {
        throw new Error(`SLA import returned ${res.status}`);
      }
      const body = (await res.json().catch(() => null)) as
        | { data?: { written?: number } }
        | null;
      return Number(body?.data?.written ?? 0);
    },
  });
  if (outcome.error) {
    // Reported, not thrown. An empty list is FieldEZ having a bad minute, and letting it
    // count as a cycle failure would march the worker towards its restart threshold over
    // something that fixes itself.
    log(`[sla] ${outcome.error}`);
  }
}

interface Job {
  key: string;
  reportName: string;
  intervalMs: number;
  run: (page: Page) => Promise<void>;
  nextRunAt: number;
}

function buildJobs(): Job[] {
  const jobs: Job[] = [
    {
      key: "wip",
      reportName: config.reportName,
      intervalMs: config.intervalMs,
      run: syncWip,
      nextRunAt: 0,
    },
  ];
  if (config.closureReportName) {
    jobs.push({
      key: "closure",
      reportName: config.closureReportName,
      intervalMs: config.closureIntervalMs,
      run: syncClosure,
      nextRunAt: 0,
    });
  }
  if (config.slaEnabled) {
    jobs.push({
      key: "sla",
      // No report to name — this one asks FieldEZ's API directly.
      reportName: "open-call SLA (API)",
      intervalMs: config.slaIntervalMs,
      run: syncSla,
      nextRunAt: 0,
    });
  }
  return jobs;
}

// ------------------------------------------------------------------ browser
//
// The browser is the one long-lived resource a cycle cannot recreate for itself, and
// it can die under the worker's feet: a renderer OOMs, the container's memory ceiling
// kills a child, a hard redeploy leaves the profile locked. The page used to be
// captured ONCE at startup and handed to every cycle, so a dead browser turned the
// worker into a silent no-op — awake, logging "cycle failed" every 15 minutes,
// recovering never and exiting never. The browser has to be re-openable mid-run.

let context: BrowserContext | null = null;
let page: Page | null = null;

/**
 * Chromium refuses to open a profile another instance still holds. A container that
 * was killed rather than stopped (OOM, `docker kill`, a redeploy that does not wait
 * out the grace period) never gets to release it, so `SingletonLock` survives on the
 * mounted profile volume pointing at a PID/hostname that no longer exists — and every
 * later start then fails on a profile nobody is using, crash-looping the worker on
 * its own warm volume. Clearing the locks is safe precisely because this is the only
 * process allowed on this profile (see the file header).
 */
function clearStaleProfileLocks(): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      rmSync(path.join(config.profileDir, name), { force: true });
    } catch {
      /* best effort — Chromium may well start anyway */
    }
  }
}

async function openBrowser(): Promise<Page> {
  clearStaleProfileLocks();
  const opened = await chromium.launchPersistentContext(config.profileDir, {
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    args: [
      // Docker's default seccomp profile blocks Chromium's namespace sandbox; the
      // container is the isolation boundary here.
      "--no-sandbox",
      // Docker gives /dev/shm 64 MB by default, and a renderer that runs past it
      // crashes the tab ("Target closed") rather than degrading — the classic way a
      // headless browser dies after days of uptime. This moves shared memory to /tmp,
      // where the container's disk is the only ceiling.
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  context = opened;
  // A browser that dies on its own must not still look healthy next cycle.
  opened.on("close", () => {
    if (context === opened) {
      context = null;
      page = null;
    }
  });
  page = opened.pages()[0] ?? (await opened.newPage());
  log("browser ready");
  return page;
}

async function closeBrowser(): Promise<void> {
  const dying = context;
  context = null;
  page = null;
  await dying?.close().catch(() => {});
}

/** The live page, relaunching the browser when the last one died. */
async function ensureBrowser(): Promise<Page> {
  if (context && page && !page.isClosed()) return page;
  if (context || page) {
    log("browser is gone — relaunching…");
    await closeBrowser();
  }
  return openBrowser();
}

async function main(): Promise<void> {
  if (!config.username || !config.password) {
    throw new Error("Set FIELDEZ_USERNAME and FIELDEZ_PASSWORD.");
  }
  mkdirSync(config.profileDir, { recursive: true });

  const jobs = buildJobs();
  log(
    `starting — api=${config.apiUrl} format=${config.format}; jobs: ` +
      jobs
        .map((j) => `${j.key}="${j.reportName}" every ${Math.round(j.intervalMs / 60000)}min`)
        .join(", "),
  );
  if (!config.closureReportName) {
    log("closure job disabled (FIELDEZ_CLOSURE_REPORT_NAME is blank)");
  }

  // A cycle that fails is ordinary (a FieldEZ blip, a slow API); a run of them is
  // not. Counting them is what turns a wedged worker into a restart rather than into
  // hours of silence nobody is watching.
  let consecutiveFailures = 0;

  try {
    while (!isShuttingDown) {
      // Drain every due job, RE-CHECKING what is due after each one finishes.
      //
      // This used to take a single snapshot of the due list and iterate it, which
      // left a hole: a job whose turn arrived WHILE another was running was not in
      // that snapshot, so the settle delay never applied to it. The loop simply fell
      // through to its 1-second floor and started it ~1s after the previous job — the
      // exact spacing that produced "[closure] import returned 500" twice. Invisible
      // at hourly intervals, unavoidable at quarter-hourly ones, where the natural
      // gap is only as wide as the WIP job is short.
      let ranThisPass = false;

      while (!isShuttingDown) {
        // Array order is the tie-break, so `wip` keeps priority over `closure`.
        const job = jobs.find((candidate) => candidate.nextRunAt <= Date.now());
        if (!job) break;

        if (ranThisPass) {
          // Let the API settle before the next job hits it: the closure import
          // failed with a 500 whenever it landed seconds behind a 2400-row report
          // generation, and succeeded every time it was clear of one.
          if (config.jobStaggerMs > 0) {
            log(`settling ${Math.round(config.jobStaggerMs / 1000)}s before the next job…`);
            await interruptibleSleep(config.jobStaggerMs);
            if (isShuttingDown) break;
          }
        }

        ranThisPass = true;
        let failed = false;
        try {
          // A failed job may have left a modal open — and the browser may not have
          // survived at all. Start every job from a live browser on a known-good
          // page, re-logging in if the FieldEZ session lapsed.
          const live = await ensureBrowser();
          await ensureReportsPage(live);
          await job.run(live);
          consecutiveFailures = 0;
        } catch (error) {
          failed = true;
          log(`[${job.key}] cycle failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          // Schedule off completion, so a slow cycle never queues up behind itself
          // — and so a job can never be immediately due again inside this loop.
          job.nextRunAt = Date.now() + job.intervalMs;
        }

        if (failed) {
          consecutiveFailures += 1;
          // Past a single blip, assume the browser is part of the problem: a wedged
          // renderer or a half-dead context survives `goto` and then fails every
          // cycle after it. Relaunching costs seconds; inheriting a dead one costs
          // every cycle that follows.
          await closeBrowser();
          if (consecutiveFailures >= config.maxConsecutiveFailures) {
            throw new Error(
              `${consecutiveFailures} cycles in a row failed — exiting so the container restarts clean`,
            );
          }
        }
      }

      if (isShuttingDown) break;
      const nextAt = Math.min(...jobs.map((job) => job.nextRunAt));
      const wait = Math.max(1000, nextAt - Date.now());
      const nextJob = jobs.find((job) => job.nextRunAt === nextAt);
      log(`next job (${nextJob?.key ?? "?"}) in ${Math.round(wait / 60000)} min`);
      await interruptibleSleep(wait);
    }
  } finally {
    await closeBrowser();
  }
}

function onSignal(sig: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`received ${sig}; finishing…`);
  shutdown.abort();
}
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));

try {
  await main();
} catch (error) {
  console.error("[fieldez] worker crashed", error);
  process.exitCode = 1;
  // Playwright can leave a handle behind, and a process that sets an exit code but
  // never actually exits is invisible to the restart policy — the very silence this
  // guard exists to end. Let the event loop drain, then force it; the timer is
  // unref'd, so it never delays a clean exit.
  setTimeout(() => process.exit(1), 5000).unref();
} finally {
  log("worker stopped");
}
