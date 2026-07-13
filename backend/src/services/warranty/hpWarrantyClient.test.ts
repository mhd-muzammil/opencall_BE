import { describe, expect, it } from "vitest";
import { isProductNumberPrompt } from "./hpWarrantyClient.js";

/**
 * The Playwright orchestration itself needs a browser, but the signal we use to
 * branch on — "did HP ask for a product number?" — is pure text and is worth
 * locking down: mis-detecting it is what made ambiguous serials fail.
 */
describe("isProductNumberPrompt", () => {
  it("detects HP's real product-number prompt wording", () => {
    const body = [
      "Check your warranty or service status",
      "Serial number",
      "This product cannot be identified using the serial number alone. Please add a product number in the field below:",
      "Product number",
    ].join("\n");

    expect(isProductNumberPrompt(body)).toBe(true);
  });

  it("detects the shorter 'add a product number' phrasing", () => {
    expect(isProductNumberPrompt("Please add a product number to continue")).toBe(
      true,
    );
  });

  it("does not fire on a resolved result page", () => {
    const body = [
      "Warranty status",
      "Status",
      "Expired",
      "Start date",
      "September 21, 2024",
      "End date",
      "November 19, 2025",
      "Product number",
      "4WF66A",
    ].join("\n");

    expect(isProductNumberPrompt(body)).toBe(false);
  });

  it("does not fire on the initial serial-only form", () => {
    const body = [
      "Check your warranty or service status",
      "Country/Region of purchase",
      "Serial number",
      "Example: HU265BM18V",
      "Submit",
    ].join("\n");

    expect(isProductNumberPrompt(body)).toBe(false);
  });
});
