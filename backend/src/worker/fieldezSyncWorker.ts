import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

/**
 * Standalone worker that mirrors the manual "download Flex WIP Report ASP from FieldEZ →
 * upload to OpenCall" step, on a timer.
 *
 * Every cycle it: keeps a warm FieldEZ session (logs in only when the session has lapsed),
 * downloads the report as XLSX, and — only if the file changed since last time — POSTs it to
 * OpenCall's /uploads endpoint so a fresh report is generated. Nothing else is touched.
 *
 * Like the warranty worker, this is the ONLY process that drives a browser; it runs on its
 * own (see the `fieldez:worker` npm script). All secrets come from env — never hard-coded.
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

/** Download the configured report as the configured format; returns the saved file path. */
async function downloadReport(page: Page): Promise<string> {
  const row = page.locator("tr", { hasText: config.reportName }).first();
  await row.waitFor({ state: "visible", timeout: 30000 });
  await row.locator("i.fa-download").first().click({ timeout: 10000 });
  await page.waitForTimeout(1200);

  const select = page.locator("select").first();
  await select.waitFor({ state: "visible", timeout: 15000 });
  await select.selectOption({ label: config.format });

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120000 }),
    page.getByRole("button", { name: /^download$/i }).first().click({ timeout: 10000 }),
  ]);
  const dest = path.join(config.profileDir, `flexwip-latest.${config.format.toLowerCase()}`);
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

interface UploadOutcome {
  status: number;
  batchStatus?: string | undefined;
  rowCount?: number | undefined;
  errorCount?: number | undefined;
  flexBatchId?: string | undefined;
}

async function uploadToOpenCall(filePath: string): Promise<UploadOutcome> {
  const buf = readFileSync(filePath);
  const doPost = async (token: string): Promise<Response> => {
    const fd = new FormData();
    fd.append("flexWipReport", new Blob([buf]), path.basename(filePath));
    if (config.regionId) fd.append("regionId", config.regionId);
    return fetch(`${config.apiUrl}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
  };

  let res = await doPost(await getToken());
  if (res.status === 401) {
    res = await doPost(await getToken(true)); // token expired — refresh once
  }
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

/** Today (IST) as YYYY-MM-DD — the report date the generate step stamps. */
function istTodayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Generate the daily call plan report from the freshly-uploaded Flex WIP batch. */
async function generateReport(
  flexBatchId: string,
): Promise<{ status: number; totalRows?: number | undefined }> {
  const doPost = (token: string): Promise<Response> => {
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
  };
  let res = await doPost(await getToken());
  if (res.status === 401) res = await doPost(await getToken(true));
  const body = (await res.json().catch(() => null)) as { data?: { totalRows?: number } } | null;
  return { status: res.status, totalRows: body?.data?.totalRows };
}

// -------------------------------------------------------------------- cycle

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const lastHashPath = () => path.join(config.profileDir, "last-uploaded.hash");
function readLastHash(): string {
  try {
    return existsSync(lastHashPath()) ? readFileSync(lastHashPath(), "utf8").trim() : "";
  } catch {
    return "";
  }
}
function writeLastHash(h: string): void {
  try {
    writeFileSync(lastHashPath(), h, "utf8");
  } catch {
    /* best effort */
  }
}

async function runCycle(page: Page): Promise<void> {
  await ensureReportsPage(page);
  const file = await downloadReport(page);
  const hash = hashFile(file);

  if (hash === readLastHash()) {
    log("report unchanged since last upload — skipping.");
    return;
  }

  log("report changed — uploading to OpenCall…");
  const out = await uploadToOpenCall(file);
  if (out.status !== 201 && out.status !== 200) {
    log(`⚠️ upload returned ${out.status} (${out.batchStatus ?? "?"}, errors=${out.errorCount ?? "?"}) — will retry next cycle`);
    return;
  }
  log(`uploaded (${out.batchStatus}, ${out.rowCount} rows, ${out.errorCount} errors) — generating report…`);

  if (!out.flexBatchId) {
    log("⚠️ no flex batch id in upload response — cannot generate; will retry next cycle");
    return;
  }
  const gen = await generateReport(out.flexBatchId);
  if (gen.status === 201 || gen.status === 200) {
    writeLastHash(hash); // only mark done once the report is actually generated
    log(`✅ report generated (${gen.totalRows ?? "?"} rows)`);
  } else {
    log(`⚠️ generate returned ${gen.status} — will retry next cycle`);
  }
}

async function main(): Promise<void> {
  if (!config.username || !config.password) {
    throw new Error("Set FIELDEZ_USERNAME and FIELDEZ_PASSWORD.");
  }
  mkdirSync(config.profileDir, { recursive: true });
  log(
    `starting — report="${config.reportName}" format=${config.format} interval=${Math.round(
      config.intervalMs / 60000,
    )}min api=${config.apiUrl}`,
  );

  const context: BrowserContext = await chromium.launchPersistentContext(config.profileDir, {
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    while (!isShuttingDown) {
      const started = Date.now();
      try {
        await runCycle(page);
      } catch (error) {
        log(`cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const elapsed = Date.now() - started;
      const wait = Math.max(0, config.intervalMs - elapsed);
      if (!isShuttingDown) {
        log(`next cycle in ${Math.round(wait / 60000)} min`);
        await interruptibleSleep(wait);
      }
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
