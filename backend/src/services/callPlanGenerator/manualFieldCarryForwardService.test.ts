import { describe, expect, it } from "vitest";
import type { FinalReportManualCarryForwardRow } from "../../repositories/dailyCallPlanReportRepository.js";
import type { EnrichedCallPlanRow, MatchedCallPlanRecord } from "../../types/matching.js";
import type { GeneratedDailyCallPlanRow } from "../../types/reportGeneration.js";
import {
  formatDailyCallPlanRow,
  orderedDailyCallPlanRow,
} from "./dailyCallPlanFormatter.js";
import {
  buildSameDayEveningAuthority,
  ManualFieldCarryForwardService,
} from "./manualFieldCarryForwardService.js";

function enrichedRow(
  overrides: Partial<EnrichedCallPlanRow> = {},
): EnrichedCallPlanRow {
  return {
    ticket_id: "WO-000123",
    case_id: "CASE-1",
    case_created_time: null,
    wip_aging: "4",
    rtpl_status: "",
    segment: "",
    engineer: null,
    product: "Notebook",
    product_line_name: "Commercial",
    work_location: "ASPS01461",
    flex_status: "Open",
    status_aging: null,
    current_status_aging: null,
    hp_owner_status: null,
    wo_otc_code: "OTC",
    account_name: "Account",
    customer_name: "Customer",
    customer_type: "Consumer",
    location: null,
    distance_km: null,
    distance_bearing: null,
    distance_is_routed: false,
    contact: null,
    part: null,
    product_serial_no: null,
    wip_aging_category: null,
    tat: null,
    customer_mail: null,
    rca: null,
    remarks: null,
    manual_notes: null,
    match_status: "MATCHED",
    ...overrides,
  };
}

function matchFor(enriched: EnrichedCallPlanRow): MatchedCallPlanRecord {
  return {
    renderways: null,
    flexWip: null,
    callPlan: null,
    flexMatchConfidence: "TICKET_ID",
    callPlanMatchConfidence: "UNMATCHED",
    matchStatus: enriched.match_status,
    enrichedRow: enriched,
    notes: [],
  };
}

function generatedRow(
  overrides: Partial<EnrichedCallPlanRow> = {},
): GeneratedDailyCallPlanRow {
  const enriched = enrichedRow(overrides);

  return {
    id: null,
    serialNo: 1,
    enriched,
    match: matchFor(enriched),
    comparison: null,
    carryForward: {
      carriedForwardFields: [],
      manualFieldsCompleted: false,
      manualFieldsMissing: [],
      changeType: null,
      previousTicketMatched: false,
      closedSyntheticRow: false,
      sameDayClosedRow: false,
      regionScopeRetainedRow: false,
    },
    updatedAt: null,
    updatedBy: null,
    rowEditable: true,
    carryForwardSource: "PREVIOUS_FINAL_REPORT",
    output: orderedDailyCallPlanRow(formatDailyCallPlanRow(1, enriched)),
  };
}

function previousFinalRow(
  overrides: Partial<FinalReportManualCarryForwardRow> = {},
): FinalReportManualCarryForwardRow {
  const row: FinalReportManualCarryForwardRow = {
    serialNo: 1,
    ticketId: "123",
    caseId: "CASE-OLD",
    caseCreatedTime: "2026-03-27T17:41:55.000Z",
    wipAging: "9",
    rtplStatus: "Pending customer",
    eveningRtplStatus: null,
    sourceReportDate: null,
    segment: "Enterprise",
    engineer: "Priya",
    product: "Old product",
    productLineName: "Commercial",
    workLocation: "ASPS01461",
    flexStatus: "Old open",
    hpOwnerStatus: "Actionable",
    woOtcCode: "OLD",
    accountName: "Old account",
    customerName: "Old customer",
    customerType: "Commercial",
    productSerialNo: "SN-OLD",
    location: "Chennai",
    contact: null,
    part: null,
    wipAgingCategory: null,
    tat: null,
    customerMail: "customer@example.com",
    rca: "Awaiting part",
    remarks: "Call after 4 PM",
    manualNotes: "Escalated locally",
    flexStatusUnchangedDays: null,
    statusAging: "2",
    changeType: null,
    sameDayClosed: false,
    eveningUpdatedAt: null,
    manualValues: {
      rtpl_status: "Pending customer",
      segment: "Enterprise",
      engineer: "Priya",
      location: "Chennai",
      case_created_time: "2026-03-27T17:41:55.000Z",
      status_aging: "2",
      hp_owner_status: "Actionable",
      customer_mail: "customer@example.com",
      rca: "Awaiting part",
      remarks: "Call after 4 PM",
      manual_notes: "Escalated locally",
    },
    ...overrides,
  };

  return {
    ...row,
    manualValues: {
      rtpl_status: row.rtplStatus,
      segment: row.segment,
      engineer: row.engineer,
      location: row.location,
      case_created_time: row.caseCreatedTime,
      status_aging: row.statusAging,
      hp_owner_status: row.hpOwnerStatus,
      customer_mail: row.customerMail,
      rca: row.rca,
      remarks: row.remarks,
      manual_notes: row.manualNotes,
      ...overrides.manualValues,
    },
  };
}

describe("ManualFieldCarryForwardService", () => {
  const service = new ManualFieldCarryForwardService();

  it("carries only missing manual fields from the previous final report", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [
        generatedRow({
          rtpl_status: "Today status",
          // Segment is freshly derived from the flex file, never carried.
          segment: "Print",
          engineer: null,
          customer_mail: "",
        }),
      ],
      previousFinalRows: [previousFinalRow()],
    });

    const [row] = result.rows;

    expect(row?.enriched.rtpl_status).toBe("Today status");
    expect(row?.enriched.engineer).toBe("Priya");
    expect(row?.enriched.customer_mail).toBe("customer@example.com");
    expect(row?.enriched.product).toBe("Notebook");
    // Segment keeps its freshly-computed value; the previous report's segment
    // ("Enterprise") is NOT carried forward.
    expect(row?.enriched.segment).toBe("Print");
    expect(row?.carryForward.carriedForwardFields).toEqual([
      "engineer",
      "location",
      "case_created_time",
      "status_aging",
      "hp_owner_status",
      "customer_mail",
      "rca",
      "remarks",
      "manual_notes",
    ]);
    expect(result.summary).toEqual({
      totalFieldsCarried: 9,
      rowsAutoCompleted: 1,
      rowsStillManual: 0,
    });
  });

  it("promotes yesterday's Evening to today's Morning and clears Evening (new day)", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ rtpl_status: "", segment: "Print" })],
      previousFinalRows: [
        previousFinalRow({
          rtplStatus: "Open",
          eveningRtplStatus: "Closed",
          sourceReportDate: "2026-03-27",
        }),
      ],
    });

    const [row] = result.rows;
    // Morning = yesterday's Evening; Evening starts blank for the new day.
    expect(row?.enriched.rtpl_status).toBe("Closed");
    expect(row?.enriched.evening_rtpl_status).toBeNull();
    expect(row?.carryForward.carriedForwardFields).toContain("rtpl_status");
  });

  it("falls back to yesterday's Morning when yesterday's Evening is blank (new day)", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ rtpl_status: "", segment: "Print" })],
      previousFinalRows: [
        previousFinalRow({
          rtplStatus: "Open",
          eveningRtplStatus: null,
          sourceReportDate: "2026-03-27",
        }),
      ],
    });

    const [row] = result.rows;
    expect(row?.enriched.rtpl_status).toBe("Open");
    expect(row?.enriched.evening_rtpl_status).toBeNull();
  });

  it("keeps the Morning baseline and preserves Evening on a same-day re-upload", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ rtpl_status: "", segment: "Print" })],
      previousFinalRows: [
        previousFinalRow({
          rtplStatus: "Open",
          eveningRtplStatus: "Closed",
          sourceReportDate: "2026-03-28",
        }),
      ],
    });

    const [row] = result.rows;
    // Same day: Morning unchanged, Evening work preserved.
    expect(row?.enriched.rtpl_status).toBe("Open");
    expect(row?.enriched.evening_rtpl_status).toBe("Closed");
  });

  it("preserves Evening on a same-day re-upload even when today's files supplied the Morning", () => {
    // Regression: matchingEngine seeds rtpl_status from the Renderways file /
    // call-plan morningStatus, so a fresh row can arrive with Morning already
    // set. The Evening rule used to hide behind the blank-Morning gate, which
    // wiped the same-day Evening work of every file-scheduled row on re-upload.
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ rtpl_status: "Scheduled", segment: "Print" })],
      previousFinalRows: [
        previousFinalRow({
          rtplStatus: "Scheduled",
          eveningRtplStatus: "Customer Pending",
          sourceReportDate: "2026-03-28",
        }),
      ],
    });

    const [row] = result.rows;
    // Morning keeps the file-supplied value (not carried); Evening survives.
    expect(row?.enriched.rtpl_status).toBe("Scheduled");
    expect(row?.carryForward.carriedForwardFields).not.toContain("rtpl_status");
    expect(row?.enriched.evening_rtpl_status).toBe("Customer Pending");
  });

  it("still clears Evening for the new day when today's files supplied the Morning", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ rtpl_status: "Scheduled", segment: "Print" })],
      previousFinalRows: [
        previousFinalRow({
          rtplStatus: "Open",
          eveningRtplStatus: "Closed",
          sourceReportDate: "2026-03-27",
        }),
      ],
    });

    const [row] = result.rows;
    expect(row?.enriched.rtpl_status).toBe("Scheduled");
    expect(row?.enriched.evening_rtpl_status).toBeNull();
  });

  it("never carries the segment forward, even when the current value is blank", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ segment: "" })],
      previousFinalRows: [previousFinalRow({ segment: "Print" })],
    });

    const [row] = result.rows;

    // Blank stays blank; the previous report's "Print" is NOT pulled in.
    expect(row?.enriched.segment).toBe("");
    expect(row?.carryForward.carriedForwardFields).not.toContain("segment");
  });

  it("uses the latest saved previous manual value during tomorrow generation", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ engineer: null })],
      previousFinalRows: [
        previousFinalRow({
          engineer: "Mike",
          manualValues: { engineer: "Mike" },
        }),
      ],
    });

    expect(result.rows[0]?.enriched.engineer).toBe("Mike");
    expect(result.rows[0]?.carryForward.carriedForwardFields).toContain("engineer");
  });

  it("carries a previously manual-entry-required field after it is saved", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ customer_mail: null })],
      previousFinalRows: [
        previousFinalRow({
          customerMail: "filled@example.com",
          manualValues: { customer_mail: "filled@example.com" },
        }),
      ],
    });

    expect(result.rows[0]?.enriched.customer_mail).toBe("filled@example.com");
    expect(result.rows[0]?.carryForward.carriedForwardFields).toContain("customer_mail");
  });

  it("does not carry placeholders and marks remaining manual fields", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      // Segment is computed from the flex file (never carried), so give it a value.
      currentRows: [generatedRow({ ticket_id: "WO-999", segment: "Print" })],
      previousFinalRows: [
        previousFinalRow({
          ticketId: "999",
          engineer: "Manual Entry Required",
          customerMail: "N/A",
          rca: "--",
          manualValues: {
            engineer: "Manual Entry Required",
            customer_mail: "N/A",
            rca: "--",
          },
        }),
      ],
    });

    const [row] = result.rows;

    expect(row?.enriched.engineer).toBeNull();
    expect(row?.enriched.customer_mail).toBeNull();
    expect(row?.enriched.rca).toBeNull();
    expect(row?.carryForward.manualFieldsMissing).toEqual([
      "engineer",
      "customer_mail",
      "rca",
    ]);
    expect(result.summary.rowsStillManual).toBe(1);
  });

  it("matches only by normalized ticket id and creates closed synthetic rows", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [
        generatedRow({
          ticket_id: "WO-777",
          case_id: "CASE-OLD",
        }),
      ],
      previousFinalRows: [previousFinalRow()],
    });

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.carryForward.changeType).toBe("NEW_WORK_ORDER");
    expect(result.rows[0]?.carryForward.previousTicketMatched).toBe(false);

    const closedRow = result.rows[1];
    expect(closedRow?.enriched.ticket_id).toBe("123");
    expect(closedRow?.carryForward.closedSyntheticRow).toBe(true);
    expect(closedRow?.carryForward.changeType).toBe("CLOSED");
    expect(closedRow?.comparison?.changeType).toBe("CLOSED");
    expect(closedRow?.enriched.engineer).toBe("Priya");
    expect(closedRow?.enriched.work_location).toBe("ASPS01461");
  });

  it("carries Customer Type and Product Serial No onto a closed row", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [],
      previousFinalRows: [previousFinalRow({ sourceReportDate: "2026-03-27" })],
    });

    expect(result.rows[0]?.enriched.customer_type).toBe("Commercial");
    expect(result.rows[0]?.enriched.product_serial_no).toBe("SN-OLD");
  });

  // A ticket absent from the Flex WIP is always CLOSED. sameDayClosedRow decides whether
  // it ALSO stays on the Records page for the rest of the day. Only the day's first
  // upload (source = a prior day) takes rows off the Records page.
  describe("same-day closed rows", () => {
    // Absent from the day's FIRST upload: closed and off the Records page immediately.
    it("does not mark a row closed by the day's first upload as same-day closed", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [previousFinalRow({ sourceReportDate: "2026-03-27" })],
      });

      expect(result.rows[0]?.carryForward.closedSyntheticRow).toBe(true);
      expect(result.rows[0]?.carryForward.sameDayClosedRow).toBe(false);
    });

    // Was active this morning, gone this afternoon: closed, but stays on Records.
    it("marks a row that closes on a same-day re-upload as same-day closed", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({ sourceReportDate: "2026-03-28", changeType: "CARRIED" }),
        ],
      });

      expect(result.rows[0]?.carryForward.closedSyntheticRow).toBe(true);
      expect(result.rows[0]?.carryForward.sameDayClosedRow).toBe(true);
    });

    // The team set Evening (e.g. "Case-Closed") before the call left the file on a
    // later same-day upload. The closed row stays on Records all day, so it must keep
    // that Evening — a blank there misreads as unfinished EOD work.
    it("keeps the Evening entered earlier today on a same-day closed row", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            changeType: "CARRIED",
            eveningRtplStatus: "Case-Closed",
          }),
        ],
      });

      expect(result.rows[0]?.carryForward.sameDayClosedRow).toBe(true);
      expect(result.rows[0]?.enriched.evening_rtpl_status).toBe("Case-Closed");
    });

    // Evening is per-day: a call closed by the day's FIRST upload must not carry
    // yesterday's Evening into today's report.
    it("leaves Evening blank on a row closed by the day's first upload", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-27",
            eveningRtplStatus: "Case-Closed",
          }),
        ],
      });

      expect(result.rows[0]?.carryForward.closedSyntheticRow).toBe(true);
      expect(result.rows[0]?.enriched.evening_rtpl_status ?? null).toBeNull();
    });

    // Upload #3 must not resurrect a row that upload #1 already took off Records.
    it("keeps a row closed by the day's first upload off Records on later re-uploads", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            changeType: "CLOSED",
            sameDayClosed: false,
          }),
        ],
      });

      expect(result.rows[0]?.carryForward.sameDayClosedRow).toBe(false);
    });

    // …and must not drop a row that upload #2 closed mid-day.
    it("keeps a mid-day closure on Records across further same-day re-uploads", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            changeType: "CLOSED",
            sameDayClosed: true,
          }),
        ],
      });

      expect(result.rows[0]?.carryForward.sameDayClosedRow).toBe(true);
    });

    // The day boundary: the next day's first upload finally takes it off Records.
    it("drops a same-day closure off Records at the next day's first upload", () => {
      const result = service.apply({
        currentReportDate: "2026-03-29",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            changeType: "CLOSED",
            sameDayClosed: true,
          }),
        ],
      });

      expect(result.rows[0]?.carryForward.closedSyntheticRow).toBe(true);
      expect(result.rows[0]?.carryForward.sameDayClosedRow).toBe(false);
    });

    // A ticket that reappears in a later Flex upload is a normal active row again.
    it("reopens a ticket that comes back in a same-day re-upload", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [generatedRow({ ticket_id: "123" })],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            changeType: "CLOSED",
            sameDayClosed: true,
          }),
        ],
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.carryForward.closedSyntheticRow).toBe(false);
      expect(result.rows[0]?.carryForward.sameDayClosedRow).toBe(false);
    });
  });

  // Multiple reports exist per day (each upload — incl. the FieldEZ auto-sync
  // worker's, every ~15 min — creates one), and users can be typing Evening
  // statuses into a report that is no longer the newest (stale tab, worker
  // churn, in-flight generation race). Carry-forward sources rows from only
  // ONE report (LIMIT 1), so an Evening entered on any OTHER same-day report
  // used to vanish from every later report — the production "Evening status
  // disappears against Scheduled cases" wipe. The same-day Evening authority
  // (the user's newest non-blank Evening per ticket across ALL of today's
  // reports) closes that hole.
  describe("same-day Evening authority", () => {
    const authorityFor = (
      eveningRtplStatus: string,
      eveningUpdatedAt = "2026-03-28 17:30:00+05:30",
    ) =>
      buildSameDayEveningAuthority([
        { ticketId: "WO-000123", eveningRtplStatus, eveningUpdatedAt },
      ]);

    // FieldEZ-worker path: flex-only upload, so the fresh row arrives with a
    // BLANK Morning; the source report (created by the worker's previous
    // cycle before the user typed) never saw the Evening entry.
    it("recovers an Evening the LIMIT-1 source chain lost (worker-shaped upload)", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [generatedRow({ rtpl_status: "", segment: "Print" })],
        previousFinalRows: [
          previousFinalRow({
            rtplStatus: "Scheduled",
            eveningRtplStatus: null,
            sourceReportDate: "2026-03-28",
          }),
        ],
        sameDayEveningAuthority: authorityFor("Attended"),
      });

      const [row] = result.rows;
      expect(row?.enriched.rtpl_status).toBe("Scheduled");
      expect(row?.enriched.evening_rtpl_status).toBe("Attended");
    });

    // Manual path: the Renderways/call-plan file supplied the Morning.
    it("recovers a lost Evening even when today's files supplied the Morning", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [
          generatedRow({ rtpl_status: "Scheduled", segment: "Print" }),
        ],
        previousFinalRows: [
          previousFinalRow({
            rtplStatus: "Scheduled",
            eveningRtplStatus: null,
            sourceReportDate: "2026-03-28",
          }),
        ],
        sameDayEveningAuthority: authorityFor("Case-Closed"),
      });

      const [row] = result.rows;
      expect(row?.enriched.rtpl_status).toBe("Scheduled");
      expect(row?.carryForward.carriedForwardFields).not.toContain("rtpl_status");
      expect(row?.enriched.evening_rtpl_status).toBe("Case-Closed");
    });

    it("prefers a newer authority Evening over the source row's older value", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [generatedRow({ segment: "Print" })],
        previousFinalRows: [
          previousFinalRow({
            rtplStatus: "Scheduled",
            eveningRtplStatus: "Attended",
            sourceReportDate: "2026-03-28",
            eveningUpdatedAt: "2026-03-28 17:00:00+05:30",
          }),
        ],
        sameDayEveningAuthority: authorityFor(
          "Case-Closed",
          "2026-03-28 17:30:00+05:30",
        ),
      });

      expect(result.rows[0]?.enriched.evening_rtpl_status).toBe("Case-Closed");
    });

    it("lets a source row whose EVENING was cleared after the authority speak for itself", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [generatedRow({ segment: "Print" })],
        previousFinalRows: [
          previousFinalRow({
            rtplStatus: "Scheduled",
            // The user deliberately cleared the Evening on the newest report,
            // which stamps the Evening's own edit timestamp.
            eveningRtplStatus: null,
            sourceReportDate: "2026-03-28",
            eveningUpdatedAt: "2026-03-28 18:00:00+05:30",
          }),
        ],
        sameDayEveningAuthority: authorityFor(
          "Case-Closed",
          "2026-03-28 17:00:00+05:30",
        ),
      });

      expect(result.rows[0]?.enriched.evening_rtpl_status ?? null).toBeNull();
    });

    it("keeps the source row's own newer Evening over an older authority entry", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [generatedRow({ segment: "Print" })],
        previousFinalRows: [
          previousFinalRow({
            rtplStatus: "Scheduled",
            eveningRtplStatus: "Attended",
            sourceReportDate: "2026-03-28",
            eveningUpdatedAt: "2026-03-28 18:00:00+05:30",
          }),
        ],
        sameDayEveningAuthority: authorityFor(
          "Case-Closed",
          "2026-03-28 17:00:00+05:30",
        ),
      });

      expect(result.rows[0]?.enriched.evening_rtpl_status).toBe("Attended");
    });

    // Regression (prod 2026-07-30): the rule compared rows.updated_at, a
    // WHOLE-ROW timestamp stamped by every manual edit. Changing only the
    // Engineer on a row whose Evening was blank therefore looked exactly like
    // "the user just cleared the Evening", and out-voted the Evening a
    // colleague had typed on another of today's reports minutes earlier — so
    // the Evening vanished on the next worker cycle.
    it("does not let an unrelated field edit pass as an Evening clear", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [generatedRow({ segment: "Print" })],
        previousFinalRows: [
          previousFinalRow({
            rtplStatus: "Scheduled",
            // Engineer edited at 19:03 (so rows.updated_at is 19:03), Evening
            // never touched on this row.
            engineer: "Newly assigned",
            eveningRtplStatus: null,
            sourceReportDate: "2026-03-28",
            eveningUpdatedAt: null,
          }),
        ],
        sameDayEveningAuthority: authorityFor(
          "Attended",
          "2026-03-28 19:01:00+05:30",
        ),
      });

      expect(result.rows[0]?.enriched.evening_rtpl_status).toBe("Attended");
    });

    it("recovers a lost Evening on a same-day closed synthetic row", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            changeType: "CARRIED",
            eveningRtplStatus: null,
          }),
        ],
        sameDayEveningAuthority: authorityFor("Case-Closed"),
      });

      expect(result.rows[0]?.carryForward.sameDayClosedRow).toBe(true);
      expect(result.rows[0]?.enriched.evening_rtpl_status).toBe("Case-Closed");
    });

    // The closed-synthetic path consults the same authority, so it inherits
    // the same false "the user cleared it" signal.
    it("keeps an unrelated edit from wiping the Evening on a same-day closed row", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            changeType: "CARRIED",
            engineer: "Newly assigned",
            eveningRtplStatus: null,
            eveningUpdatedAt: null,
          }),
        ],
        sameDayEveningAuthority: authorityFor(
          "Case-Closed",
          "2026-03-28 19:01:00+05:30",
        ),
      });

      expect(result.rows[0]?.carryForward.sameDayClosedRow).toBe(true);
      expect(result.rows[0]?.enriched.evening_rtpl_status).toBe("Case-Closed");
    });

    it("keeps a deliberate Evening clear on a same-day closed row", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            changeType: "CARRIED",
            eveningRtplStatus: null,
            eveningUpdatedAt: "2026-03-28 19:05:00+05:30",
          }),
        ],
        sameDayEveningAuthority: authorityFor(
          "Case-Closed",
          "2026-03-28 19:01:00+05:30",
        ),
      });

      expect(result.rows[0]?.enriched.evening_rtpl_status ?? null).toBeNull();
    });

    // Evening is per-day: a prior-day source (the day's first upload) starts
    // blank no matter what — the authority only ever holds same-day entries,
    // so this can only trigger with a stale/foreign map and must still be a
    // no-op.
    it("never applies the authority to a prior-day closure", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-27",
            eveningRtplStatus: "Case-Closed",
          }),
        ],
        sameDayEveningAuthority: authorityFor("Case-Closed"),
      });

      expect(result.rows[0]?.carryForward.closedSyntheticRow).toBe(true);
      expect(result.rows[0]?.enriched.evening_rtpl_status ?? null).toBeNull();
    });

    it("recovers a lost Evening on an out-of-scope retained row", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            workLocation: "ASPS01463",
            changeType: "CARRIED",
            rtplStatus: "Scheduled",
            eveningRtplStatus: null,
          }),
        ],
        allowedWorkLocations: new Set(["ASPS01461"]),
        sameDayEveningAuthority: authorityFor("Attended"),
      });

      const [row] = result.rows;
      expect(row?.carryForward.regionScopeRetainedRow).toBe(true);
      expect(row?.enriched.rtpl_status).toBe("Scheduled");
      expect(row?.enriched.evening_rtpl_status).toBe("Attended");
    });

    // The region-retained path consults the same authority as the matched and
    // closed paths, so it inherits the same false "the user cleared it" signal.
    it("keeps an unrelated edit from wiping the Evening on a retained row", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            workLocation: "ASPS01463",
            changeType: "CARRIED",
            rtplStatus: "Scheduled",
            engineer: "Newly assigned",
            eveningRtplStatus: null,
            eveningUpdatedAt: null,
          }),
        ],
        allowedWorkLocations: new Set(["ASPS01461"]),
        sameDayEveningAuthority: authorityFor(
          "Attended",
          "2026-03-28 19:01:00+05:30",
        ),
      });

      const [row] = result.rows;
      expect(row?.carryForward.regionScopeRetainedRow).toBe(true);
      expect(row?.enriched.evening_rtpl_status).toBe("Attended");
    });

    it("keeps a deliberate Evening clear on a retained row", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            workLocation: "ASPS01463",
            changeType: "CARRIED",
            rtplStatus: "Scheduled",
            eveningRtplStatus: null,
            eveningUpdatedAt: "2026-03-28 19:05:00+05:30",
          }),
        ],
        allowedWorkLocations: new Set(["ASPS01461"]),
        sameDayEveningAuthority: authorityFor(
          "Attended",
          "2026-03-28 19:01:00+05:30",
        ),
      });

      const [row] = result.rows;
      expect(row?.carryForward.regionScopeRetainedRow).toBe(true);
      expect(row?.enriched.evening_rtpl_status ?? null).toBeNull();
    });

    it("applies a user-set same-day Evening even when the source report misses the ticket", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [generatedRow({ segment: "Print" })],
        previousFinalRows: [],
        sameDayEveningAuthority: authorityFor("Attended"),
      });

      expect(result.rows[0]?.enriched.evening_rtpl_status).toBe("Attended");
    });

    it("buildSameDayEveningAuthority keeps the newest entry per ticket and drops placeholders", () => {
      const authority = buildSameDayEveningAuthority([
        // Ordered most-recently-edited first, exactly as the repository
        // returns them.
        {
          ticketId: "WO-000123",
          eveningRtplStatus: "Case-Closed",
          eveningUpdatedAt: "2026-03-28 18:00:00+05:30",
        },
        {
          ticketId: "123",
          eveningRtplStatus: "Attended",
          eveningUpdatedAt: "2026-03-28 17:00:00+05:30",
        },
        {
          ticketId: "WO-777",
          eveningRtplStatus: "N/A",
          eveningUpdatedAt: "2026-03-28 16:00:00+05:30",
        },
      ]);

      // "WO-000123" and "123" normalize to the same ticket; newest wins.
      expect(authority.size).toBe(1);
      const [entry] = authority.values();
      expect(entry?.eveningRtplStatus).toBe("Case-Closed");
      expect(entry?.eveningUpdatedAt).toBe("2026-03-28 18:00:00+05:30");
    });
  });

  // A region-scoped upload (allowedWorkLocations set) may close only its own
  // regions' calls. Absent tickets from other regions are carried forward
  // verbatim as retained active rows, never closed.
  describe("region-scoped uploads", () => {
    const CHENNAI = "ASPS01461";
    const VELLORE = "ASPS01463";

    it("retains an out-of-scope active ticket instead of closing it", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-27",
            workLocation: VELLORE,
            changeType: "CARRIED",
          }),
        ],
        allowedWorkLocations: new Set([CHENNAI]),
      });

      const row = result.rows[0];
      expect(row?.carryForward.closedSyntheticRow).toBe(false);
      expect(row?.carryForward.regionScopeRetainedRow).toBe(true);
      expect(row?.carryForward.changeType).toBe("CARRIED");
      expect(row?.comparison?.changeType).toBe("CARRIED");
      // Values reproduced from the previous report, untouched by this upload.
      expect(row?.enriched.engineer).toBe("Priya");
      expect(row?.enriched.work_location).toBe(VELLORE);
      expect(row?.enriched.customer_type).toBe("Commercial");
    });

    it("still closes an in-scope absent ticket when a scope is set", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-27",
            workLocation: CHENNAI,
          }),
        ],
        allowedWorkLocations: new Set([CHENNAI]),
      });

      expect(result.rows[0]?.carryForward.closedSyntheticRow).toBe(true);
      expect(result.rows[0]?.carryForward.regionScopeRetainedRow).toBe(false);
    });

    it("keeps an out-of-scope already-closed ticket closed with same-day inheritance", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            workLocation: VELLORE,
            changeType: "CLOSED",
            sameDayClosed: true,
          }),
        ],
        allowedWorkLocations: new Set([CHENNAI]),
      });

      expect(result.rows[0]?.carryForward.closedSyntheticRow).toBe(true);
      expect(result.rows[0]?.carryForward.sameDayClosedRow).toBe(true);
    });

    it("treats a blank work location as out of scope when a scope is set", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({ sourceReportDate: "2026-03-27", workLocation: null }),
        ],
        allowedWorkLocations: new Set([CHENNAI]),
      });

      expect(result.rows[0]?.carryForward.closedSyntheticRow).toBe(false);
      expect(result.rows[0]?.carryForward.regionScopeRetainedRow).toBe(true);
    });

    it("promotes Evening to Morning on retained rows across the day boundary", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-27",
            workLocation: VELLORE,
            rtplStatus: "Part Pending",
            eveningRtplStatus: "WO-closed",
          }),
        ],
        allowedWorkLocations: new Set([CHENNAI]),
      });

      expect(result.rows[0]?.enriched.rtpl_status).toBe("WO-closed");
      expect(result.rows[0]?.enriched.evening_rtpl_status).toBeNull();
    });

    it("preserves Morning and Evening on retained rows within the same day", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({
            sourceReportDate: "2026-03-28",
            workLocation: VELLORE,
            rtplStatus: "Part Pending",
            eveningRtplStatus: "Customer not available",
          }),
        ],
        allowedWorkLocations: new Set([CHENNAI]),
      });

      expect(result.rows[0]?.enriched.rtpl_status).toBe("Part Pending");
      expect(result.rows[0]?.enriched.evening_rtpl_status).toBe("Customer not available");
    });

    it("closes everything as before when no scope is set", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [],
        previousFinalRows: [
          previousFinalRow({ sourceReportDate: "2026-03-27", workLocation: VELLORE }),
        ],
        allowedWorkLocations: null,
      });

      expect(result.rows[0]?.carryForward.closedSyntheticRow).toBe(true);
      expect(result.rows[0]?.carryForward.regionScopeRetainedRow).toBe(false);
    });
  });

  // Feature B — auto-RCA for fresh NEW calls (write-once, then frozen/carried).
  describe("auto-RCA for fresh NEW calls", () => {
    const service = new ManualFieldCarryForwardService();

    it("fills a fresh active call with the active-case line", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [
          generatedRow({
            ticket_id: "WO-NEW-1",
            case_created_time: "2026-03-25T10:00:00.000Z",
            rca: null,
            part: null,
            engineer: null,
          }),
        ],
        previousFinalRows: [],
      });
      expect(result.rows[0]?.carryForward.changeType).toBe("NEW_WORK_ORDER");
      expect(result.rows[0]?.enriched.rca).toBe(
        "Case Received on 25th March - active case",
      );
      expect(result.rows[0]?.output["RCA"]).toBe(
        "Case Received on 25th March - active case",
      );
      // The auto-RCA must be marked carried so it PERSISTS (fresh insert) and
      // BACKFILLS into existing reports on restore — otherwise it shows but
      // isn't saved and "disappears" the moment the row is edited/scheduled.
      expect(result.rows[0]?.carryForward.carriedForwardFields).toContain("rca");
    });

    it("adds the engineer-scheduled suffix when a fresh call has an engineer", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [
          generatedRow({
            ticket_id: "WO-NEW-2",
            case_created_time: "2026-03-25T10:00:00.000Z",
            rca: null,
            part: null,
            engineer: "Praveen",
          }),
        ],
        previousFinalRows: [],
      });
      expect(result.rows[0]?.enriched.rca).toBe(
        "Case Received on 25th March - active case - engineer scheduled 28th March",
      );
    });

    it("fills a fresh part call with the shipment-status ETA line", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [
          generatedRow({
            ticket_id: "WO-NEW-3",
            case_created_time: "2026-03-25T10:00:00.000Z",
            rca: null,
            part: "Motherboard",
            part_shipment_status: "Shipped",
            engineer: "Praveen",
          }),
        ],
        previousFinalRows: [],
      });
      expect(result.rows[0]?.enriched.rca).toBe(
        "Case Received on 25th March - with part - (Motherboard) ETA: 26th March",
      );
    });

    it("never overwrites an existing (Renderways/human) RCA on a fresh call", () => {
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [
          generatedRow({
            ticket_id: "WO-NEW-4",
            case_created_time: "2026-03-25T10:00:00.000Z",
            rca: "Existing RCA from Renderways",
            part: null,
            engineer: null,
          }),
        ],
        previousFinalRows: [],
      });
      expect(result.rows[0]?.enriched.rca).toBe("Existing RCA from Renderways");
    });

    // Regression (prod 2026-07-30): matchingEngine stores case_created_time as
    // `parseCustomDate(...).toISOString()`, i.e. UTC. IST is UTC+05:30, so a
    // case created in the early hours IST lands on the PREVIOUS UTC date and the
    // RCA read "Case Received on 29th July" for a 30-07-2026 04:00 AM case —
    // while the grid's own CASE CREATED TIME column (Asia/Kolkata) said 30th.
    // Cases from 06:09 AM onwards were unaffected, pinning it to the 05:30 line.
    it("labels an early-morning IST case with its own IST calendar day", () => {
      // 30-07-2026 04:00:21 AM IST, exactly as it is persisted.
      const result = service.apply({
        currentReportDate: "2026-07-30",
        currentRows: [
          generatedRow({
            ticket_id: "WO-NEW-IST",
            case_created_time: "2026-07-29T22:30:21.000Z",
            rca: null,
            part: null,
            engineer: null,
          }),
        ],
        previousFinalRows: [],
      });
      expect(result.rows[0]?.enriched.rca).toBe(
        "Case Received on 30th July - active case",
      );
    });

    it("derives a part ETA from the IST creation day, not the UTC one", () => {
      // Same 04:00:21 AM IST instant; "Shipped" is created + 1 day => 31st July.
      const result = service.apply({
        currentReportDate: "2026-07-30",
        currentRows: [
          generatedRow({
            ticket_id: "WO-NEW-IST-PART",
            case_created_time: "2026-07-29T22:30:21.000Z",
            rca: null,
            part: "Motherboard",
            part_shipment_status: "Shipped",
            engineer: null,
          }),
        ],
        previousFinalRows: [],
      });
      expect(result.rows[0]?.enriched.rca).toBe(
        "Case Received on 30th July - with part - (Motherboard) ETA: 31st July",
      );
    });

    it("does not auto-RCA a CARRIED row (only fresh NEW calls)", () => {
      // Default ticket keys match (WO-000123 <-> 123), so this row is CARRIED.
      const result = service.apply({
        currentReportDate: "2026-03-28",
        currentRows: [generatedRow({ rca: null, part: null, engineer: null })],
        previousFinalRows: [previousFinalRow({ rca: null })],
      });
      expect(result.rows[0]?.carryForward.changeType).toBe("CARRIED");
      expect(result.rows[0]?.enriched.rca ?? "").not.toMatch(/Case Received on/);
    });
  });
});
