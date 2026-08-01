import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";

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
  // Pause between two jobs that came due in the same cycle, so the second one does
  // not hit the API while the first one's report generation is still finishing.
  jobStaggerMs: num("FIELDEZ_JOB_STAGGER_MS", 60 * 1000),
  // OpenCall target
  apiUrl: str("OPENCALL_API_URL", "http://localhost:4000").replace(/\/$/, ""),
  token: str("OPENCALL_TOKEN"),
  ocUser: str("OPENCALL_USERNAME"),
  ocPass: str("OPENCALL_PASSWORD"),
  regionId: str("OPENCALL_REGION_ID"),
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

/** Download one report; returns the saved file path. */
async function downloadReport(page: Page, options: DownloadOptions): Promise<string> {
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

  if (hash === readLastHash("closure")) {
    log("[closure] report unchanged since last import — skipping.");
    return;
  }

  // The byte size distinguishes a real workbook from an error page or an empty
  // export, which is the other way this import can fail with a server error.
  const bytes = statSync(file).size;
  log(`[closure] report changed (${today}, ${bytes} bytes) — importing to OpenCall…`);

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
  return jobs;
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

  const context: BrowserContext = await chromium.launchPersistentContext(config.profileDir, {
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

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

        // A failed job may have left a modal open; start every job from a
        // known-good page, and re-log in if the session lapsed.
        await ensureReportsPage(page).catch((error: unknown) => {
          log(`could not reach the reports page: ${error instanceof Error ? error.message : String(error)}`);
        });

        ranThisPass = true;
        try {
          await job.run(page);
        } catch (error) {
          log(`[${job.key}] cycle failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          // Schedule off completion, so a slow cycle never queues up behind itself
          // — and so a job can never be immediately due again inside this loop.
          job.nextRunAt = Date.now() + job.intervalMs;
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
    await context.close().catch(() => {});
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
} finally {
  log("worker stopped");
}
