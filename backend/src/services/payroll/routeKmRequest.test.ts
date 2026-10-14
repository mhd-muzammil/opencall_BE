import { describe, expect, it } from "vitest";
import { MAX_KM_RANGE_DAYS, daysInKmRange } from "./rosterKmRange.js";
import {
  MAX_ROUTE_KM_ENGINEERS,
  parseRouteKmDayRequest,
  parseRouteKmRequest,
} from "./routeKmRequest.js";

const TODAY = "2026-10-14";

/** The last bill cycle, wholly in the past, for two engineers. */
function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { from: "2026-08-25", to: "2026-09-24", engineer_ids: [7, 8], ...extra };
}

const RANGE_REFUSED = { ok: false, message: expect.stringMatching(/^from and to /) };
const IDS_REFUSED = { ok: false, message: expect.stringMatching(/^engineer_ids /) };

describe("parseRouteKmRequest", () => {
  it("takes the period and the engineers as sent", () => {
    expect(parseRouteKmRequest(body(), TODAY)).toEqual({
      ok: true,
      engineerIds: [7, 8],
      from: "2026-08-25",
      to: "2026-09-24",
    });
  });

  it("takes a single day", () => {
    expect(parseRouteKmRequest(body({ from: "2026-09-24", to: "2026-09-24" }), TODAY)).toMatchObject({
      ok: true,
    });
  });

  it("reads ids sent as digits", () => {
    expect(parseRouteKmRequest(body({ engineer_ids: ["7", "08", 9] }), TODAY)).toMatchObject({
      ok: true,
      engineerIds: [7, 8, 9],
    });
  });

  it("asks about each engineer once, in the order first given", () => {
    expect(parseRouteKmRequest(body({ engineer_ids: [9, 7, 9, "7", 8] }), TODAY)).toMatchObject({
      ok: true,
      engineerIds: [9, 7, 8],
    });
  });

  it("takes up to 300 ids and refuses the 301st", () => {
    expect(MAX_ROUTE_KM_ENGINEERS).toBe(300);
    const ids = Array.from({ length: 300 }, (_, index) => index + 1);
    expect(parseRouteKmRequest(body({ engineer_ids: ids }), TODAY)).toMatchObject({
      ok: true,
      engineerIds: ids,
    });
    expect(parseRouteKmRequest(body({ engineer_ids: [...ids, 301] }), TODAY)).toEqual(IDS_REFUSED);
  });

  it("counts the ids as sent: 301 is too many even when one repeats", () => {
    const ids = [...Array.from({ length: 300 }, (_, index) => index + 1), 1];
    expect(parseRouteKmRequest(body({ engineer_ids: ids }), TODAY)).toEqual(IDS_REFUSED);
  });

  it("refuses a body with no engineer_ids", () => {
    expect(parseRouteKmRequest({ from: "2026-08-25", to: "2026-09-24" }, TODAY)).toEqual(IDS_REFUSED);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an empty list", []],
    ["a single number", 7],
    ["a string of ids", "7,8"],
    ["an object", { 0: 7 }],
  ])("refuses engineer_ids that is %s", (_label, engineerIds) => {
    expect(parseRouteKmRequest(body({ engineer_ids: engineerIds }), TODAY)).toEqual(IDS_REFUSED);
  });

  it.each<[string, unknown]>([
    ["zero", 0],
    ["negative", -3],
    ["a fraction", 7.5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["beyond a safe integer", 2 ** 53],
    ["the digits of zero", "0"],
    ["a negative in text", "-3"],
    ["a fraction in text", "7.5"],
    ["padded with a space", " 7"],
    ["not digits", "7a"],
    ["empty text", ""],
    ["digits beyond a safe integer", "9007199254740993"],
    ["a boolean", true],
    ["null", null],
    ["a nested list", [7]],
    ["an object", { id: 7 }],
  ])("refuses an id that is %s", (_label, id) => {
    expect(parseRouteKmRequest(body({ engineer_ids: [7, id] }), TODAY)).toEqual(IDS_REFUSED);
  });

  it.each<[string, unknown]>([
    ["missing", undefined],
    ["null", null],
    ["text", "x"],
    ["a number", 7],
    ["a list", [7, 8]],
  ])("refuses a body that is %s", (_label, requestBody) => {
    expect(parseRouteKmRequest(requestBody, TODAY)).toMatchObject({ ok: false });
  });

  // daysInKmRange checks only the shape: on its own it would ask about 30
  // February, take month 13 as a bound, and throw on month 00 or day 32.
  it.each<[string, unknown, unknown]>([
    ["no from", undefined, "2026-09-24"],
    ["no to", "2026-08-25", undefined],
    ["day-first", "25-08-2026", "2026-09-24"],
    ["unpadded", "2026-8-25", "2026-09-24"],
    ["a timestamp", "2026-08-25T00:00:00Z", "2026-09-24"],
    ["a number", 20260825, "2026-09-24"],
    ["30 February", "2026-02-30", "2026-03-05"],
    ["29 February outside a leap year", "2026-02-29", "2026-03-05"],
    ["31 April", "2026-04-31", "2026-05-05"],
    ["month 00", "2026-00-01", "2026-01-05"],
    ["month 13", "2026-08-25", "2026-13-01"],
    ["day 32", "2026-08-32", "2026-09-05"],
  ])("refuses dates that are %s", (_label, from, to) => {
    expect(parseRouteKmRequest(body({ from, to }), TODAY)).toEqual(RANGE_REFUSED);
  });

  it("refuses a period that runs backwards", () => {
    expect(parseRouteKmRequest(body({ from: "2026-09-24", to: "2026-08-25" }), TODAY)).toEqual(
      RANGE_REFUSED,
    );
  });

  it("allows exactly 62 days and refuses 63", () => {
    // The limit Payroll holds route km to as well.
    expect(MAX_KM_RANGE_DAYS).toBe(62);
    // 1 Jan to 3 Mar 2026 is 62 days counting both ends; to 4 Mar is 63.
    expect(parseRouteKmRequest(body({ from: "2026-01-01", to: "2026-03-03" }), TODAY)).toMatchObject({
      ok: true,
    });
    expect(parseRouteKmRequest(body({ from: "2026-01-01", to: "2026-03-04" }), TODAY)).toEqual(
      RANGE_REFUSED,
    );
  });

  it("takes a period that runs past today as sent, as the RTPL table does", () => {
    // The current bill cycle, as the KM Report asks for it on 14 Oct.
    expect(parseRouteKmRequest(body({ from: "2026-09-25", to: "2026-10-24" }), TODAY)).toEqual({
      ok: true,
      engineerIds: [7, 8],
      from: "2026-09-25",
      to: "2026-10-24",
    });
  });

  it("takes a period wholly after today: it has no days yet, which is not an error", () => {
    expect(daysInKmRange("2026-10-25", "2026-11-24", TODAY)).toEqual([]);
    expect(parseRouteKmRequest(body({ from: "2026-10-25", to: "2026-11-24" }), TODAY)).toMatchObject({
      ok: true,
    });
  });

  it("counts the 62 days only up to today, as daysInKmRange does", () => {
    // 1 Sep to 31 Dec is 122 days, of which 44 have happened by 14 Oct.
    expect(parseRouteKmRequest(body({ from: "2026-09-01", to: "2026-12-31" }), TODAY)).toMatchObject({
      ok: true,
    });
  });
});

describe("parseRouteKmDayRequest", () => {
  const DATE_REFUSED = { ok: false, message: expect.stringMatching(/^date /) };
  const ENGINEER_REFUSED = { ok: false, message: expect.stringMatching(/^engineerId /) };

  it("takes the engineer from the URL and the day from the query", () => {
    expect(parseRouteKmDayRequest("7", "2026-09-25")).toEqual({
      ok: true,
      engineerId: 7,
      date: "2026-09-25",
    });
  });

  it("takes an id that is already a number", () => {
    expect(parseRouteKmDayRequest(7, "2026-09-25")).toEqual({
      ok: true,
      engineerId: 7,
      date: "2026-09-25",
    });
  });

  it("takes 29 February in a leap year", () => {
    expect(parseRouteKmDayRequest("7", "2028-02-29")).toMatchObject({ ok: true, date: "2028-02-29" });
  });

  it("has no rule about today: a day after it is passed on", () => {
    expect(parseRouteKmDayRequest("7", "2026-10-20")).toMatchObject({ ok: true, date: "2026-10-20" });
  });

  it.each<[string, unknown]>([
    ["missing", undefined],
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-7"],
    ["a fraction", "7.5"],
    ["not digits", "7a"],
    ["padded with a space", " 7"],
    ["beyond a safe integer", "9007199254740993"],
    ["a zero number", 0],
    ["a negative number", -7],
    ["a fractional number", 7.5],
  ])("refuses an engineerId that is %s", (_label, engineerId) => {
    expect(parseRouteKmDayRequest(engineerId, "2026-09-25")).toEqual(ENGINEER_REFUSED);
  });

  it.each<[string, unknown]>([
    ["missing", undefined],
    ["empty", ""],
    ["day-first", "25-09-2026"],
    ["unpadded", "2026-9-25"],
    ["a timestamp", "2026-09-25T00:00:00Z"],
    ["repeated in the query", ["2026-09-25", "2026-09-26"]],
    ["an object", { from: "2026-09-25" }],
    ["30 February", "2026-02-30"],
    ["29 February outside a leap year", "2026-02-29"],
    ["31 April", "2026-04-31"],
    ["month 00", "2026-00-10"],
    ["month 13", "2026-13-01"],
  ])("refuses a date that is %s", (_label, date) => {
    expect(parseRouteKmDayRequest("7", date)).toEqual(DATE_REFUSED);
  });
});
