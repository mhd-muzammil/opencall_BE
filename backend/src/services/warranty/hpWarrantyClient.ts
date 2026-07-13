import type { Page } from "playwright";
import {
  parseWarrantyResult,
  type ParsedWarrantyResult,
} from "./warrantyResultParser.js";

/**
 * Drives HP's public warranty-check page for a single serial.
 *
 * Playwright is imported **type-only** here: the Express API must never pull the
 * browser runtime into its process. Only the worker passes a live `Page` in.
 *
 * reCAPTCHA v3 (invisible) guards the form. We do not attempt to bypass it — the
 * worker paces requests and reuses a warm browser profile so the invisible score
 * stays healthy. If HP ever escalates to an *interactive* challenge we abort the
 * item with `InteractiveChallengeError` and let it be retried later.
 */

export const DEFAULT_HP_WARRANTY_URL =
  "https://support.hp.com/in-en/check-warranty";

/** Marker of a resolved result page. */
const RESULT_URL_FRAGMENT = "/warrantyresult/";

const DEFAULT_TIMEOUT_MS = 45_000;

export class InteractiveChallengeError extends Error {
  constructor(message = "HP presented an interactive challenge") {
    super(message);
    this.name = "InteractiveChallengeError";
  }
}

export class WarrantyLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarrantyLookupError";
  }
}

/** Selectors are tried in order; the first visible one wins. */
const SERIAL_INPUT_SELECTORS = [
  "#inputtextpfinder",
  'input[placeholder*="HU265BM18V"]',
  'input[placeholder*="serial" i]',
  'input[aria-label*="serial" i]',
];

/**
 * The product-number field HP reveals when a serial is ambiguous.
 *
 * Its real id is `product-number inputtextPN` — an id *containing a space*, so a
 * `#id` CSS selector cannot address it (the space reads as a descendant
 * combinator). Match it with an attribute selector instead.
 */
const PRODUCT_INPUT_SELECTORS = [
  'input[id="product-number inputtextPN"]',
  'input[placeholder*="7NM78PA"]',
  'input[placeholder*="product number" i]',
  'input[aria-label*="product number" i]',
];

/** Submits the serial-only form. */
const SERIAL_SUBMIT_SELECTORS = [
  "#FindMyProduct",
  'button:has-text("Submit"):visible',
];

/**
 * Submits the serial + product-number form. HP swaps in a *different* button for
 * this step. Note we never fall back to a bare `button[type="submit"]` — HP's
 * "Sign in" button is also a submit button and would hijack the flow.
 */
const PRODUCT_SUBMIT_SELECTORS = [
  "#FindMyProductNumber",
  'button:has-text("Submit"):visible',
];

/** HP's wording when the serial alone is not enough to identify the unit. */
const PRODUCT_NUMBER_PROMPT_PATTERN =
  /cannot be identified using the serial number alone|add a product number/i;

/** True when HP is asking for a product number rather than showing a result. */
export function isProductNumberPrompt(pageText: string): boolean {
  return PRODUCT_NUMBER_PROMPT_PATTERN.test(pageText);
}

/**
 * Interactive-challenge tells. The invisible reCAPTCHA v3 badge is always on the
 * page and is *not* one of these — only a visible, blocking challenge counts.
 */
const CHALLENGE_SELECTORS = [
  'iframe[title*="recaptcha challenge" i]',
  'iframe[src*="/recaptcha/api2/bframe"]',
  'iframe[title*="hcaptcha" i]',
  "#px-captcha",
];

const CHALLENGE_TEXT_PATTERN =
  /(verify you are (a )?human|press (&|and) hold|unusual traffic|are you a robot|access denied)/i;

async function firstVisible(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  do {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        return selector;
      }
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);

  return null;
}

async function assertNoInteractiveChallenge(page: Page): Promise<void> {
  for (const selector of CHALLENGE_SELECTORS) {
    const visible = await page
      .locator(selector)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) {
      throw new InteractiveChallengeError(
        `HP presented an interactive challenge (${selector})`,
      );
    }
  }

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  if (CHALLENGE_TEXT_PATTERN.test(bodyText)) {
    throw new InteractiveChallengeError(
      "HP presented an interactive challenge (challenge text detected)",
    );
  }
}

async function submitForm(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
): Promise<void> {
  const submitSelector = await firstVisible(page, selectors, 5_000);
  if (submitSelector) {
    await page.locator(submitSelector).first().click({ timeout: timeoutMs });
    return;
  }

  // Some variants of the form have no visible button; Enter submits it.
  await page.keyboard.press("Enter");
}

/** Dismisses the OneTrust cookie banner if it is up. Best-effort. */
async function dismissCookieBanner(page: Page): Promise<void> {
  const accept = page.locator("#onetrust-accept-btn-handler").first();
  if (await accept.isVisible().catch(() => false)) {
    await accept.click({ timeout: 5_000 }).catch(() => undefined);
  }
}

type SubmitOutcome = "result" | "product-number-prompt";

/**
 * After a submit, HP either lands on a `/warrantyresult/` page or re-renders the
 * form asking for a product number. Waiting on the result URL alone would burn
 * the whole timeout on every ambiguous serial, so poll for either outcome.
 */
async function waitForOutcome(
  page: Page,
  timeoutMs: number,
): Promise<SubmitOutcome | null> {
  const deadline = Date.now() + timeoutMs;

  do {
    if (page.url().includes(RESULT_URL_FRAGMENT)) {
      return "result";
    }

    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    if (isProductNumberPrompt(bodyText)) {
      return "product-number-prompt";
    }

    await page.waitForTimeout(500);
  } while (Date.now() < deadline);

  return null;
}

/**
 * Waits for navigation to the result page.
 *
 * Used after the *product-number* submit, where polling for "either outcome" is
 * unsafe: the prompt text is still on screen at click time, so a text poll would
 * report the prompt again before the navigation even starts.
 */
async function waitForResultPage(page: Page, timeoutMs: number): Promise<boolean> {
  await page
    .waitForURL((url) => url.href.includes(RESULT_URL_FRAGMENT), {
      timeout: timeoutMs,
    })
    .catch(() => undefined);

  return page.url().includes(RESULT_URL_FRAGMENT);
}

/**
 * Reads the visible text of the resolved result page. The parser keys off the
 * `End date` / `Status` labels, not layout, so the whole body is the right input:
 * HP renders the warranty coverage card at the top of the page, while
 * `Additional Information` is a *separate* collapsed accordion whose body is not
 * a descendant of its heading — scoping to it captured only the heading text and
 * produced false `NOT_FOUND`s.
 */
async function readResultText(page: Page): Promise<string> {
  return page
    .locator("body")
    .innerText()
    .catch(() => "");
}

export interface LookupWarrantyOptions {
  hpUrl?: string;
  timeoutMs?: number;
}

/**
 * Looks up one serial. Resolves with the parsed result (`OK` / `NOT_FOUND`);
 * throws on anything else so the caller can mark the item `FAILED` and retry.
 */
export async function lookupWarranty(
  page: Page,
  serial: string,
  productNumber: string | null,
  options: LookupWarrantyOptions = {},
): Promise<ParsedWarrantyResult> {
  const hpUrl = options.hpUrl ?? DEFAULT_HP_WARRANTY_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await page.goto(hpUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  // The cookie banner does not block the form, but dismissing it keeps clicks
  // from ever being intercepted.
  await dismissCookieBanner(page);
  await assertNoInteractiveChallenge(page);

  const serialSelector = await firstVisible(page, SERIAL_INPUT_SELECTORS, 15_000);
  if (!serialSelector) {
    throw new WarrantyLookupError("Serial input not found on the HP form");
  }

  await page.locator(serialSelector).first().fill(serial, { timeout: timeoutMs });
  await submitForm(page, SERIAL_SUBMIT_SELECTORS, timeoutMs);

  const outcome = await waitForOutcome(page, timeoutMs);
  await assertNoInteractiveChallenge(page);

  if (outcome === null) {
    throw new WarrantyLookupError(
      `HP neither resolved serial ${serial} nor asked for a product number`,
    );
  }

  if (outcome === "product-number-prompt") {
    // HP could not identify the unit from the serial alone and wants column K
    // (with the `#ACJ`-style localization suffix already stripped).
    if (!productNumber) {
      throw new WarrantyLookupError(
        `HP asked for a product number for serial ${serial} but the row has none`,
      );
    }

    const productSelector = await firstVisible(page, PRODUCT_INPUT_SELECTORS, 10_000);
    if (!productSelector) {
      throw new WarrantyLookupError(
        `HP asked for a product number for serial ${serial} but the input was not found`,
      );
    }

    await page.locator(productSelector).first().fill(productNumber, {
      timeout: timeoutMs,
    });
    await submitForm(page, PRODUCT_SUBMIT_SELECTORS, timeoutMs);

    const resolved = await waitForResultPage(page, timeoutMs);
    await assertNoInteractiveChallenge(page);

    if (!resolved) {
      throw new WarrantyLookupError(
        `HP did not resolve serial ${serial} even with product number ${productNumber}`,
      );
    }
  }

  const resultText = await readResultText(page);
  return parseWarrantyResult(resultText);
}
