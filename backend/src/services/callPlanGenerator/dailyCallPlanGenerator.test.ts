import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { MatchedCallPlanRecord } from "../../types/matching.js";
import type { FinalReportManualCarryForwardRow } from "../../repositories/dailyCallPlanReportRepository.js";
import { MANUAL_ENTRY_REQUIRED } from "./dailyCallPlanFormatter.js";

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  validateReportGenerationTransaction: vi.fn(),
  findFlexWipRecordsByBatchId: vi.fn(),
  findRenderwaysRecordsByBatchId: vi.fn(),
  findCallPlanRecordsByBatchId: vi.fn(),
  findActiveSlaHoursByCategory: vi.fn(),
  findAreaNameByPincode: vi.fn(),
  findRegionOfficesByAspCode: vi.fn(),
  findPincodeCoordinates: vi.fn(),
  findRoadDistances: vi.fn(),
  matchSourceRecords: vi.fn(),
  findPreviousFinalReportRowsForManualCarryForward: vi.fn(),
  findFlexStatusHistoryForUnchangedDays: vi.fn(),
  findSameDayUserSetEveningRows: vi.fn(),
  adoptReportRowEveningStatusFromAuthority: vi.fn(),
  findDailyCallPlanReportRowMetadataByReportId: vi.fn(),
  backfillMissingDailyCallPlanReportRowCarryForward: vi.fn(),
  overwriteCarriedForwardFieldValues: vi.fn(),
  createDailyCallPlanReport: vi.fn(),
  insertDailyCallPlanReportRows: vi.fn(),
  findOrCreateCompletedHistorySessionForReport: vi.fn(),
  findPreviousCompletedComparisonSession: vi.fn(),
  findComparableReportRowsBySessionId: vi.fn(),
  replaceReportComparison: vi.fn(),
  findUploadBatchesForValidation: vi.fn(),
  findRegionById: vi.fn(),
  findMaxDailyCallPlanReportRowSerialNo: vi.fn(),
}));

vi.mock("../../config/database.js", () => ({
  withTransaction: mocks.withTransaction,
}));

vi.mock("../../repositories/businessRuleRepository.js", () => ({
  findActiveSlaHoursByCategory: mocks.findActiveSlaHoursByCategory,
  findAreaNameByPincode: mocks.findAreaNameByPincode,
}));

vi.mock("../../repositories/dailyCallPlanReportRepository.js", () => ({
  backfillMissingDailyCallPlanReportRowCarryForward:
    mocks.backfillMissingDailyCallPlanReportRowCarryForward,
  overwriteCarriedForwardFieldValues:
    mocks.overwriteCarriedForwardFieldValues,
  createDailyCallPlanReport: mocks.createDailyCallPlanReport,
  findDailyCallPlanReportRowMetadataByReportId:
    mocks.findDailyCallPlanReportRowMetadataByReportId,
  findPreviousFinalReportRowsForManualCarryForward:
    mocks.findPreviousFinalReportRowsForManualCarryForward,
  findFlexStatusHistoryForUnchangedDays:
    mocks.findFlexStatusHistoryForUnchangedDays,
  findSameDayUserSetEveningRows: mocks.findSameDayUserSetEveningRows,
  adoptReportRowEveningStatusFromAuthority: mocks.adoptReportRowEveningStatusFromAuthority,
  insertDailyCallPlanReportRows: mocks.insertDailyCallPlanReportRows,
  findMaxDailyCallPlanReportRowSerialNo:
    mocks.findMaxDailyCallPlanReportRowSerialNo,
}));

vi.mock("../../repositories/historyRepository.js", () => ({
  findOrCreateCompletedHistorySessionForReport:
    mocks.findOrCreateCompletedHistorySessionForReport,
}));

vi.mock("../../repositories/reportComparisonRepository.js", () => ({
  findComparableReportRowsBySessionId: mocks.findComparableReportRowsBySessionId,
  findPreviousCompletedComparisonSession:
    mocks.findPreviousCompletedComparisonSession,
  replaceReportComparison: mocks.replaceReportComparison,
}));

vi.mock("../../repositories/sourceRecordRepository.js", () => ({
  findCallPlanRecordsByBatchId: mocks.findCallPlanRecordsByBatchId,
  findFlexWipRecordsByBatchId: mocks.findFlexWipRecordsByBatchId,
  findRenderwaysRecordsByBatchId: mocks.findRenderwaysRecordsByBatchId,
}));

vi.mock("../compareService/matchingEngine.js", () => ({
  matchSourceRecords: mocks.matchSourceRecords,
}));

vi.mock("./reportGenerationValidation.js", () => ({
  validateReportGenerationTransaction: mocks.validateReportGenerationTransaction,
}));

vi.mock("../../repositories/uploadBatchRepository.js", () => ({
  findUploadBatchesForValidation: mocks.findUploadBatchesForValidation,
}));

vi.mock("../../repositories/regionRepository.js", () => ({
  findRegionById: mocks.findRegionById,
}));

vi.mock("../../repositories/geoRepository.js", () => ({
  findRegionOfficesByAspCode: mocks.findRegionOfficesByAspCode,
  findPincodeCoordinates: mocks.findPincodeCoordinates,
  findRoadDistances: mocks.findRoadDistances,
  // The exact-address tier stays empty here: these tests exercise carry-forward
  // and matching, and an empty map is exactly the no-provider production state.
  findPreciseWorkOrderCoordinates: async () => new Map(),
  findAddressRoadDistances: async () => new Map(),
  roadDistanceKey: (asp: string, pin: string) => `${asp.trim().toUpperCase()}|${pin}`,
  addressRoadDistanceKey: (asp: string, key: string) => `${asp.trim().toUpperCase()}|${key}`,
}));

function previousFinalRow(): FinalReportManualCarryForwardRow {
  return {
    serialNo: 1,
    ticketId: "WO-123",
    caseId: "CASE-1",
    caseCreatedTime: "2026-05-25T04:30:00.000Z",
    wipAging: "5",
    rtplStatus: "Part Pending",
    eveningRtplStatus: null,
    sourceReportDate: null,
    segment: "Enterprise",
    engineer: "Priya",
    product: "Notebook",
    productLineName: "Commercial",
    workLocation: "ASP501461",
    flexStatus: "Open",
    hpOwnerStatus: "Actionable",
    woOtcCode: "OTC",
    accountName: "Account",
    customerName: "Customer",
    customerType: "Commercial",
    productSerialNo: null,
    location: "Chennai",
    contact: null,
    part: null,
    wipAgingCategory: null,
    tat: null,
    customerMail: "customer@example.com",
    rca: "Awaiting part",
    remarks: null,
    manualNotes: null,
    flexStatusUnchangedDays: null,
    statusAging: "2",
    changeType: null,
    sameDayClosed: false,
    eveningUpdatedAt: null,
    manualValues: {
      rtpl_status: "Part Pending",
      segment: "Enterprise",
      engineer: "Priya",
      location: "Chennai",
      case_created_time: "2026-05-25T04:30:00.000Z",
      status_aging: "2",
      hp_owner_status: "Actionable",
      customer_mail: "customer@example.com",
      rca: "Awaiting part",
      remarks: null,
      manual_notes: null,
    },
  };
}

function currentMatch(): MatchedCallPlanRecord {
  return {
    renderways: null,
    flexWip: {
      id: "flex-1",
      rowNumber: 1,
      ticketId: "WO-123",
      normalizedTicketId: "WO123",
      caseId: "CASE-1",
      normalizedCaseId: "CASE1",
      createTime: new Date("2026-05-26T04:30:00.000Z"),
      product: "Notebook",
      productLineName: "Commercial",
      workLocation: "ASP501461",
      flexStatus: "Open",
      woOtcCode: "OTC",
      accountName: "Account",
      customerName: "Customer",
      customerPincode: null,
      customerAddress: null,
      commonAddress: null,
      customerCity: null,
      customerState: null,
      contact: null,
      partDescription: null,
      customerEmail: null,
      productSerialNo: null,
      businessSegment: null,
      rawRow: {},
    },
    callPlan: null,
    flexMatchConfidence: "TICKET_ID",
    callPlanMatchConfidence: "UNMATCHED",
    matchStatus: "CALLPLAN_MISSING",
    enrichedRow: {
      ticket_id: "WO-123",
      case_id: "CASE-1",
      case_created_time: "2026-05-26T04:30:00.000Z",
      wip_aging: "1",
      rtpl_status: "",
      segment: "",
      engineer: null,
      product: "Notebook",
      product_line_name: "Commercial",
      work_location: "ASP501461",
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
      match_status: "CALLPLAN_MISSING",
    },
    notes: [],
  };
}

describe("generateDailyCallPlanReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: an unscoped (full-coverage) Flex batch — no batch-derived scope.
    mocks.findUploadBatchesForValidation.mockResolvedValue([]);
    mocks.findRegionById.mockResolvedValue(null);
    mocks.findMaxDailyCallPlanReportRowSerialNo.mockResolvedValue(0);
    // Default: no user-set same-day Evening statuses.
    mocks.findSameDayUserSetEveningRows.mockResolvedValue([]);
    mocks.adoptReportRowEveningStatusFromAuthority.mockResolvedValue(undefined);
  });

  it("does not let blank persisted RTPL erase previous-final carry-forward on existing reports", async () => {
    const { generateDailyCallPlanReport } = await import("./dailyCallPlanGenerator.js");
    const client = {} as PoolClient;

    mocks.withTransaction.mockImplementation(async (callback) => callback(client));
    mocks.validateReportGenerationTransaction.mockResolvedValue("report-1");
    mocks.findFlexWipRecordsByBatchId.mockResolvedValue([{ ticketId: "WO-123", rowNumber: 1 }]);
    mocks.findRenderwaysRecordsByBatchId.mockResolvedValue([]);
    mocks.findCallPlanRecordsByBatchId.mockResolvedValue([]);
    mocks.findActiveSlaHoursByCategory.mockResolvedValue(new Map());
    mocks.findAreaNameByPincode.mockResolvedValue(new Map());
    mocks.findRegionOfficesByAspCode.mockResolvedValue(new Map());
    mocks.findPincodeCoordinates.mockResolvedValue(new Map());
    mocks.findRoadDistances.mockResolvedValue(new Map());
    mocks.matchSourceRecords.mockReturnValue([currentMatch()]);
    mocks.findPreviousFinalReportRowsForManualCarryForward.mockResolvedValue([
      previousFinalRow(),
    ]);
    mocks.findFlexStatusHistoryForUnchangedDays.mockResolvedValue([]);
    mocks.findDailyCallPlanReportRowMetadataByReportId.mockResolvedValue([
      {
        id: "row-1",
        serialNo: 1,
        ticketId: "WO-123",
        caseCreatedTime: null,
        wipAging: "1",
        statusAging: null,
        hpOwnerStatus: null,
        rtplStatus: "",
        segment: "",
        engineer: null,
        location: null,
        customerMail: null,
        rca: null,
        remarks: null,
        manualNotes: null,
        carriedForwardFields: [],
        manualFieldsCompleted: false,
        manualFieldsMissing: ["rtpl_status"],
        updatedAt: null,
        updatedBy: null,
        isExcluded: false,
      },
    ]);
    mocks.findOrCreateCompletedHistorySessionForReport.mockResolvedValue({
      id: "session-1",
    });
    mocks.findPreviousCompletedComparisonSession.mockResolvedValue(null);

    const report = await generateDailyCallPlanReport({
      reportDate: "2026-05-26",
      generatedBy: "user-1",
      regionId: "region-1",
      flexUploadBatchId: "batch-flex",
    });

    expect(report.rows[0]?.enriched.rtpl_status).toBe("Part Pending");
    expect(report.rows[0]?.output["RTPL status"]).toBe("Part Pending");
    expect(
      mocks.backfillMissingDailyCallPlanReportRowCarryForward,
    ).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        rowId: "row-1",
        rtplStatus: "Part Pending",
      }),
    );
  });

  it("keeps a deliberately cleared engineer blank instead of re-carrying it", async () => {
    // The Records-page bug this exists to stop: an admin disables an engineer,
    // sets that engineer's open calls back to "Entry" and saves. Every page
    // load re-runs generation, and a blank persisted engineer used to fall
    // through to the carried-forward name from the previous report — which was
    // then written back into the row, so the disabled engineer reappeared
    // instantly, in incognito, for everyone.
    const { generateDailyCallPlanReport } = await import("./dailyCallPlanGenerator.js");
    const client = {} as PoolClient;

    mocks.withTransaction.mockImplementation(async (callback) => callback(client));
    mocks.validateReportGenerationTransaction.mockResolvedValue("report-1");
    mocks.findFlexWipRecordsByBatchId.mockResolvedValue([{ ticketId: "WO-123", rowNumber: 1 }]);
    mocks.findRenderwaysRecordsByBatchId.mockResolvedValue([]);
    mocks.findCallPlanRecordsByBatchId.mockResolvedValue([]);
    mocks.findActiveSlaHoursByCategory.mockResolvedValue(new Map());
    mocks.findAreaNameByPincode.mockResolvedValue(new Map());
    mocks.findRegionOfficesByAspCode.mockResolvedValue(new Map());
    mocks.findPincodeCoordinates.mockResolvedValue(new Map());
    mocks.findRoadDistances.mockResolvedValue(new Map());
    mocks.matchSourceRecords.mockReturnValue([currentMatch()]);
    // The source report still holds the (now disabled) engineer.
    mocks.findPreviousFinalReportRowsForManualCarryForward.mockResolvedValue([
      previousFinalRow(),
    ]);
    mocks.findFlexStatusHistoryForUnchangedDays.mockResolvedValue([]);
    mocks.findDailyCallPlanReportRowMetadataByReportId.mockResolvedValue([
      {
        id: "row-1",
        serialNo: 1,
        ticketId: "WO-123",
        caseCreatedTime: null,
        wipAging: "1",
        statusAging: null,
        hpOwnerStatus: null,
        rtplStatus: "Part Pending",
        segment: "",
        engineer: null,
        location: null,
        customerMail: null,
        rca: null,
        remarks: null,
        manualNotes: null,
        carriedForwardFields: [],
        manualFieldsCompleted: false,
        manualFieldsMissing: ["engineer"],
        manuallyClearedFields: ["engineer"],
        updatedAt: null,
        updatedBy: null,
        isExcluded: false,
      },
    ]);
    mocks.findOrCreateCompletedHistorySessionForReport.mockResolvedValue({
      id: "session-1",
    });
    mocks.findPreviousCompletedComparisonSession.mockResolvedValue(null);

    const report = await generateDailyCallPlanReport({
      reportDate: "2026-05-26",
      generatedBy: "user-1",
      regionId: "region-1",
      flexUploadBatchId: "batch-flex",
    });

    expect(report.rows[0]?.enriched.engineer).toBeNull();
    expect(report.rows[0]?.output.Engineer).toBe(MANUAL_ENTRY_REQUIRED);
    expect(report.rows[0]?.carryForward.carriedForwardFields).not.toContain(
      "engineer",
    );
    // Nothing may be written back over the clear either — the repair path is
    // how the old name reached the database in the first place.
    expect(
      mocks.backfillMissingDailyCallPlanReportRowCarryForward,
    ).not.toHaveBeenCalledWith(
      client,
      expect.objectContaining({ engineer: "Priya" }),
    );
    expect(mocks.overwriteCarriedForwardFieldValues).not.toHaveBeenCalledWith(
      client,
      expect.objectContaining({ engineer: "Priya" }),
    );
  });

  it("re-carries a field again once the user gives it a value back", async () => {
    // The clear is remembered, not permanent: assigning a real engineer drops
    // the field out of the cleared list at save time, so the row behaves like
    // any other from then on. Here the list is empty and the blank is a plain
    // "never filled in", which must still inherit.
    const { generateDailyCallPlanReport } = await import("./dailyCallPlanGenerator.js");
    const client = {} as PoolClient;

    mocks.withTransaction.mockImplementation(async (callback) => callback(client));
    mocks.validateReportGenerationTransaction.mockResolvedValue("report-1");
    mocks.findFlexWipRecordsByBatchId.mockResolvedValue([{ ticketId: "WO-123", rowNumber: 1 }]);
    mocks.findRenderwaysRecordsByBatchId.mockResolvedValue([]);
    mocks.findCallPlanRecordsByBatchId.mockResolvedValue([]);
    mocks.findActiveSlaHoursByCategory.mockResolvedValue(new Map());
    mocks.findAreaNameByPincode.mockResolvedValue(new Map());
    mocks.findRegionOfficesByAspCode.mockResolvedValue(new Map());
    mocks.findPincodeCoordinates.mockResolvedValue(new Map());
    mocks.findRoadDistances.mockResolvedValue(new Map());
    mocks.matchSourceRecords.mockReturnValue([currentMatch()]);
    mocks.findPreviousFinalReportRowsForManualCarryForward.mockResolvedValue([
      previousFinalRow(),
    ]);
    mocks.findFlexStatusHistoryForUnchangedDays.mockResolvedValue([]);
    mocks.findDailyCallPlanReportRowMetadataByReportId.mockResolvedValue([
      {
        id: "row-1",
        serialNo: 1,
        ticketId: "WO-123",
        caseCreatedTime: null,
        wipAging: "1",
        statusAging: null,
        hpOwnerStatus: null,
        rtplStatus: "Part Pending",
        segment: "",
        engineer: null,
        location: null,
        customerMail: null,
        rca: null,
        remarks: null,
        manualNotes: null,
        carriedForwardFields: [],
        manualFieldsCompleted: false,
        manualFieldsMissing: ["engineer"],
        manuallyClearedFields: [],
        updatedAt: null,
        updatedBy: null,
        isExcluded: false,
      },
    ]);
    mocks.findOrCreateCompletedHistorySessionForReport.mockResolvedValue({
      id: "session-1",
    });
    mocks.findPreviousCompletedComparisonSession.mockResolvedValue(null);

    const report = await generateDailyCallPlanReport({
      reportDate: "2026-05-26",
      generatedBy: "user-1",
      regionId: "region-1",
      flexUploadBatchId: "batch-flex",
    });

    expect(report.rows[0]?.enriched.engineer).toBe("Priya");
  });

  it("refreshes an inherited field when the source report now holds a newer value", async () => {
    const { generateDailyCallPlanReport } = await import("./dailyCallPlanGenerator.js");
    const client = {} as PoolClient;

    // The latest prior (source) report now has a newer RTPL status than the
    // snapshot this report froze when it was generated.
    const source = previousFinalRow();
    source.rtplStatus = "Escalated";
    source.manualValues = { ...source.manualValues, rtpl_status: "Escalated" };

    mocks.withTransaction.mockImplementation(async (callback) => callback(client));
    mocks.validateReportGenerationTransaction.mockResolvedValue("report-1");
    mocks.findFlexWipRecordsByBatchId.mockResolvedValue([{ ticketId: "WO-123", rowNumber: 1 }]);
    mocks.findRenderwaysRecordsByBatchId.mockResolvedValue([]);
    mocks.findCallPlanRecordsByBatchId.mockResolvedValue([]);
    mocks.findActiveSlaHoursByCategory.mockResolvedValue(new Map());
    mocks.findAreaNameByPincode.mockResolvedValue(new Map());
    mocks.findRegionOfficesByAspCode.mockResolvedValue(new Map());
    mocks.findPincodeCoordinates.mockResolvedValue(new Map());
    mocks.findRoadDistances.mockResolvedValue(new Map());
    mocks.matchSourceRecords.mockReturnValue([currentMatch()]);
    mocks.findPreviousFinalReportRowsForManualCarryForward.mockResolvedValue([source]);
    mocks.findFlexStatusHistoryForUnchangedDays.mockResolvedValue([]);
    // This report only *inherited* RTPL (it is in carriedForwardFields, never
    // edited here) and still holds the stale "Part Pending" snapshot.
    mocks.findDailyCallPlanReportRowMetadataByReportId.mockResolvedValue([
      {
        id: "row-1",
        serialNo: 1,
        ticketId: "WO-123",
        caseCreatedTime: null,
        wipAging: "1",
        statusAging: null,
        hpOwnerStatus: null,
        rtplStatus: "Part Pending",
        segment: "",
        engineer: "Priya",
        location: "Chennai",
        customerMail: "customer@example.com",
        rca: "Awaiting part",
        remarks: null,
        manualNotes: null,
        carriedForwardFields: ["rtpl_status"],
        manualFieldsCompleted: true,
        manualFieldsMissing: [],
        updatedAt: null,
        updatedBy: null,
        isExcluded: false,
      },
    ]);
    mocks.findOrCreateCompletedHistorySessionForReport.mockResolvedValue({
      id: "session-1",
    });
    mocks.findPreviousCompletedComparisonSession.mockResolvedValue(null);

    const report = await generateDailyCallPlanReport({
      reportDate: "2026-05-26",
      generatedBy: "user-1",
      regionId: "region-1",
      flexUploadBatchId: "batch-flex",
    });

    // In-memory row reflects the newer source value, not the frozen snapshot.
    expect(report.rows[0]?.enriched.rtpl_status).toBe("Escalated");
    expect(report.rows[0]?.output["RTPL status"]).toBe("Escalated");
    // And it is persisted via an overwrite (not the fill-if-empty backfill).
    expect(mocks.overwriteCarriedForwardFieldValues).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ rowId: "row-1", rtplStatus: "Escalated" }),
    );
    expect(
      mocks.backfillMissingDailyCallPlanReportRowCarryForward,
    ).not.toHaveBeenCalled();
  });

  // Regression for the production "Evening status disappears against Scheduled
  // cases" wipe, remaining vector (2026-07-29): the FieldEZ auto-sync worker
  // creates a NEW report every ~15 min, and the Evening a user entered lands on
  // a report that is no longer the newest (stale tab / worker churn / edits
  // saved while the next generation was already in flight). The LIMIT-1
  // carry-forward source never sees that Evening, so every later report was
  // written with a blank Evening. The same-day Evening authority must recover
  // it.
  it("a worker-shaped upload never blanks an Evening set on another same-day report", async () => {
    const { generateDailyCallPlanReport } = await import("./dailyCallPlanGenerator.js");
    const client = {} as PoolClient;

    mocks.withTransaction.mockImplementation(async (callback) => callback(client));
    // The worker uploads a brand-new flex batch each cycle -> a NEW report.
    mocks.validateReportGenerationTransaction.mockResolvedValue(null);
    mocks.createDailyCallPlanReport.mockResolvedValue("report-new");
    mocks.findFlexWipRecordsByBatchId.mockResolvedValue([{ ticketId: "WO-123", rowNumber: 1 }]);
    mocks.findRenderwaysRecordsByBatchId.mockResolvedValue([]);
    mocks.findCallPlanRecordsByBatchId.mockResolvedValue([]);
    mocks.findActiveSlaHoursByCategory.mockResolvedValue(new Map());
    mocks.findAreaNameByPincode.mockResolvedValue(new Map());
    mocks.findRegionOfficesByAspCode.mockResolvedValue(new Map());
    mocks.findPincodeCoordinates.mockResolvedValue(new Map());
    mocks.findRoadDistances.mockResolvedValue(new Map());
    // Flex-only upload (no Renderways/call plan): the fresh row's Morning is
    // blank, exactly what the worker produces.
    mocks.matchSourceRecords.mockReturnValue([currentMatch()]);

    // LIMIT-1 source: an earlier report from TODAY whose row is Scheduled but
    // whose Evening column never saw the user's entry.
    const source = previousFinalRow();
    source.sourceReportDate = "2026-05-26";
    source.rtplStatus = "Scheduled";
    source.eveningRtplStatus = null;
    source.manualValues = { ...source.manualValues, rtpl_status: "Scheduled" };
    mocks.findPreviousFinalReportRowsForManualCarryForward.mockResolvedValue([source]);
    mocks.findFlexStatusHistoryForUnchangedDays.mockResolvedValue([]);

    // ...but the user DID set an Evening today, on a different same-day report.
    mocks.findSameDayUserSetEveningRows.mockResolvedValue([
      {
        ticketId: "WO-123",
        eveningRtplStatus: "Attended",
        eveningUpdatedAt: "2026-05-26 17:30:00+05:30",
      },
    ]);

    mocks.findOrCreateCompletedHistorySessionForReport.mockResolvedValue({
      id: "session-1",
    });
    mocks.findPreviousCompletedComparisonSession.mockResolvedValue(null);

    // Worker request shape: flex batch only, no region, allowCreate.
    const report = await generateDailyCallPlanReport({
      reportDate: "2026-05-26",
      generatedBy: "worker-user",
      regionId: null,
      flexUploadBatchId: "batch-flex",
      allowCreate: true,
    });

    expect(report.rows[0]?.enriched.rtpl_status).toBe("Scheduled");
    expect(report.rows[0]?.enriched.evening_rtpl_status).toBe("Attended");

    // And the NEW report is persisted with the Evening intact.
    const [, , insertedRows] = mocks.insertDailyCallPlanReportRows.mock.calls[0] as [
      unknown,
      string,
      Array<{ enriched: { evening_rtpl_status: string | null } }>,
    ];
    expect(insertedRows[0]?.enriched.evening_rtpl_status).toBe("Attended");
  });

  it("heals a blank persisted Evening on an existing report from the same-day authority", async () => {
    const { generateDailyCallPlanReport } = await import("./dailyCallPlanGenerator.js");
    const client = {} as PoolClient;

    mocks.withTransaction.mockImplementation(async (callback) => callback(client));
    mocks.validateReportGenerationTransaction.mockResolvedValue("report-1");
    mocks.findFlexWipRecordsByBatchId.mockResolvedValue([{ ticketId: "WO-123", rowNumber: 1 }]);
    mocks.findRenderwaysRecordsByBatchId.mockResolvedValue([]);
    mocks.findCallPlanRecordsByBatchId.mockResolvedValue([]);
    mocks.findActiveSlaHoursByCategory.mockResolvedValue(new Map());
    mocks.findAreaNameByPincode.mockResolvedValue(new Map());
    mocks.findRegionOfficesByAspCode.mockResolvedValue(new Map());
    mocks.findPincodeCoordinates.mockResolvedValue(new Map());
    mocks.findRoadDistances.mockResolvedValue(new Map());
    mocks.matchSourceRecords.mockReturnValue([currentMatch()]);
    mocks.findPreviousFinalReportRowsForManualCarryForward.mockResolvedValue([]);
    mocks.findFlexStatusHistoryForUnchangedDays.mockResolvedValue([]);
    mocks.findSameDayUserSetEveningRows.mockResolvedValue([
      {
        ticketId: "WO-123",
        eveningRtplStatus: "Case-Closed",
        eveningUpdatedAt: "2026-05-26 17:30:00+05:30",
      },
    ]);
    // This report's own row was never user-edited and its Evening is blank —
    // the report was generated before the user's entry on another report.
    mocks.findDailyCallPlanReportRowMetadataByReportId.mockResolvedValue([
      {
        id: "row-1",
        serialNo: 1,
        ticketId: "WO-123",
        caseCreatedTime: null,
        wipAging: "1",
        statusAging: null,
        hpOwnerStatus: null,
        rtplStatus: "Scheduled",
        eveningRtplStatus: null,
        segment: "",
        engineer: "Priya",
        location: null,
        customerMail: null,
        rca: null,
        remarks: null,
        manualNotes: null,
        carriedForwardFields: [],
        manualFieldsCompleted: false,
        manualFieldsMissing: [],
        updatedAt: null,
        eveningUpdatedAt: null,
        updatedBy: null,
        isExcluded: false,
      },
    ]);
    mocks.findOrCreateCompletedHistorySessionForReport.mockResolvedValue({
      id: "session-1",
    });
    mocks.findPreviousCompletedComparisonSession.mockResolvedValue(null);

    const report = await generateDailyCallPlanReport({
      reportDate: "2026-05-26",
      generatedBy: "user-1",
      regionId: null,
      flexUploadBatchId: "batch-flex",
      allowCreate: false,
    });

    expect(report.rows[0]?.enriched.evening_rtpl_status).toBe("Case-Closed");
    expect(mocks.adoptReportRowEveningStatusFromAuthority).toHaveBeenCalledWith(client, {
      rowId: "row-1",
      eveningRtplStatus: "Case-Closed",
      authorityEveningUpdatedAt: "2026-05-26 17:30:00+05:30",
    });
  });

  /**
   * The reported symptom, and the one every earlier fix missed: "I change the
   * Evening status and it comes back to the same OLD status".
   *
   * Vectors 1-4 all addressed the Evening VANISHING, and the heal was gated on
   * `if (!persisted.eveningRtplStatus)` — so a row still holding a stale value
   * was skipped entirely and a newer entry made on another of today's reports
   * could never reach it. With the FieldEZ worker minting a report every ~15
   * minutes, the report a user is shown is very often not the one they typed
   * into, so this fired constantly.
   */
  it("replaces a STALE non-blank Evening with the newer same-day authority", async () => {
    const { generateDailyCallPlanReport } = await import("./dailyCallPlanGenerator.js");
    const client = {} as PoolClient;

    mocks.withTransaction.mockImplementation(async (callback) => callback(client));
    mocks.validateReportGenerationTransaction.mockResolvedValue("report-1");
    mocks.findFlexWipRecordsByBatchId.mockResolvedValue([{ ticketId: "WO-123", rowNumber: 1 }]);
    mocks.findRenderwaysRecordsByBatchId.mockResolvedValue([]);
    mocks.findCallPlanRecordsByBatchId.mockResolvedValue([]);
    mocks.findActiveSlaHoursByCategory.mockResolvedValue(new Map());
    mocks.findAreaNameByPincode.mockResolvedValue(new Map());
    mocks.findRegionOfficesByAspCode.mockResolvedValue(new Map());
    mocks.findPincodeCoordinates.mockResolvedValue(new Map());
    mocks.findRoadDistances.mockResolvedValue(new Map());
    mocks.matchSourceRecords.mockReturnValue([currentMatch()]);
    mocks.findPreviousFinalReportRowsForManualCarryForward.mockResolvedValue([]);
    mocks.findFlexStatusHistoryForUnchangedDays.mockResolvedValue([]);

    // The user changed the Evening to "Attended" at 18:00 on ANOTHER of today's
    // reports.
    mocks.findSameDayUserSetEveningRows.mockResolvedValue([
      {
        ticketId: "WO-123",
        eveningRtplStatus: "Attended",
        eveningUpdatedAt: "2026-05-26 18:00:00+05:30",
      },
    ]);

    // This report's row still carries the OLDER "Case-Closed", set at 17:00.
    // Not blank — which is exactly why the old gate skipped it.
    mocks.findDailyCallPlanReportRowMetadataByReportId.mockResolvedValue([
      {
        id: "row-1",
        serialNo: 1,
        ticketId: "WO-123",
        caseCreatedTime: null,
        wipAging: "1",
        statusAging: null,
        hpOwnerStatus: null,
        rtplStatus: "Scheduled",
        eveningRtplStatus: "Case-Closed",
        segment: "",
        engineer: "Priya",
        location: null,
        customerMail: null,
        rca: null,
        remarks: null,
        manualNotes: null,
        carriedForwardFields: [],
        manualFieldsCompleted: false,
        manualFieldsMissing: [],
        updatedAt: "2026-05-26 17:00:00+05:30",
        eveningUpdatedAt: "2026-05-26 17:00:00+05:30",
        updatedBy: null,
        isExcluded: false,
      },
    ]);
    mocks.findOrCreateCompletedHistorySessionForReport.mockResolvedValue({
      id: "session-1",
    });
    mocks.findPreviousCompletedComparisonSession.mockResolvedValue(null);

    const report = await generateDailyCallPlanReport({
      reportDate: "2026-05-26",
      generatedBy: "user-1",
      regionId: null,
      flexUploadBatchId: "batch-flex",
      allowCreate: false,
    });

    expect(report.rows[0]?.enriched.evening_rtpl_status).toBe("Attended");
    expect(mocks.adoptReportRowEveningStatusFromAuthority).toHaveBeenCalledWith(client, {
      rowId: "row-1",
      eveningRtplStatus: "Attended",
      authorityEveningUpdatedAt: "2026-05-26 18:00:00+05:30",
    });
  });

  it("never heals over a row whose EVENING was cleared after the authority entry", async () => {
    const { generateDailyCallPlanReport } = await import("./dailyCallPlanGenerator.js");
    const client = {} as PoolClient;

    mocks.withTransaction.mockImplementation(async (callback) => callback(client));
    mocks.validateReportGenerationTransaction.mockResolvedValue("report-1");
    mocks.findFlexWipRecordsByBatchId.mockResolvedValue([{ ticketId: "WO-123", rowNumber: 1 }]);
    mocks.findRenderwaysRecordsByBatchId.mockResolvedValue([]);
    mocks.findCallPlanRecordsByBatchId.mockResolvedValue([]);
    mocks.findActiveSlaHoursByCategory.mockResolvedValue(new Map());
    mocks.findAreaNameByPincode.mockResolvedValue(new Map());
    mocks.findRegionOfficesByAspCode.mockResolvedValue(new Map());
    mocks.findPincodeCoordinates.mockResolvedValue(new Map());
    mocks.findRoadDistances.mockResolvedValue(new Map());
    mocks.matchSourceRecords.mockReturnValue([currentMatch()]);
    mocks.findPreviousFinalReportRowsForManualCarryForward.mockResolvedValue([]);
    mocks.findFlexStatusHistoryForUnchangedDays.mockResolvedValue([]);
    mocks.findSameDayUserSetEveningRows.mockResolvedValue([
      {
        ticketId: "WO-123",
        eveningRtplStatus: "Case-Closed",
        eveningUpdatedAt: "2026-05-26 17:00:00+05:30",
      },
    ]);
    // The user edited THIS row after the authority entry (e.g. cleared the
    // Evening here) — the row speaks for itself.
    mocks.findDailyCallPlanReportRowMetadataByReportId.mockResolvedValue([
      {
        id: "row-1",
        serialNo: 1,
        ticketId: "WO-123",
        caseCreatedTime: null,
        wipAging: "1",
        statusAging: null,
        hpOwnerStatus: null,
        rtplStatus: "Scheduled",
        eveningRtplStatus: null,
        segment: "",
        engineer: "Priya",
        location: null,
        customerMail: null,
        rca: null,
        remarks: null,
        manualNotes: null,
        carriedForwardFields: [],
        manualFieldsCompleted: false,
        manualFieldsMissing: [],
        updatedAt: "2026-05-26 18:00:00+05:30",
        eveningUpdatedAt: "2026-05-26 18:00:00+05:30",
        updatedBy: "user-1",
        isExcluded: false,
      },
    ]);
    mocks.findOrCreateCompletedHistorySessionForReport.mockResolvedValue({
      id: "session-1",
    });
    mocks.findPreviousCompletedComparisonSession.mockResolvedValue(null);

    const report = await generateDailyCallPlanReport({
      reportDate: "2026-05-26",
      generatedBy: "user-1",
      regionId: null,
      flexUploadBatchId: "batch-flex",
      allowCreate: false,
    });

    expect(report.rows[0]?.enriched.evening_rtpl_status ?? null).toBeNull();
    expect(mocks.adoptReportRowEveningStatusFromAuthority).not.toHaveBeenCalled();
  });

  // Regression (prod 2026-07-30): the heal compared rows.updated_at, which
  // every manual edit stamps, so editing only the Engineer on a row whose
  // Evening was blank made the row "speak for itself" and the Evening a
  // colleague had entered on another of today's reports stayed lost.
  it("still heals a blank Evening when only an unrelated field was edited", async () => {
    const { generateDailyCallPlanReport } = await import("./dailyCallPlanGenerator.js");
    const client = {} as PoolClient;

    mocks.withTransaction.mockImplementation(async (callback) => callback(client));
    mocks.validateReportGenerationTransaction.mockResolvedValue("report-1");
    mocks.findFlexWipRecordsByBatchId.mockResolvedValue([{ ticketId: "WO-123", rowNumber: 1 }]);
    mocks.findRenderwaysRecordsByBatchId.mockResolvedValue([]);
    mocks.findCallPlanRecordsByBatchId.mockResolvedValue([]);
    mocks.findActiveSlaHoursByCategory.mockResolvedValue(new Map());
    mocks.findAreaNameByPincode.mockResolvedValue(new Map());
    mocks.findRegionOfficesByAspCode.mockResolvedValue(new Map());
    mocks.findPincodeCoordinates.mockResolvedValue(new Map());
    mocks.findRoadDistances.mockResolvedValue(new Map());
    mocks.matchSourceRecords.mockReturnValue([currentMatch()]);
    mocks.findPreviousFinalReportRowsForManualCarryForward.mockResolvedValue([]);
    mocks.findFlexStatusHistoryForUnchangedDays.mockResolvedValue([]);
    mocks.findSameDayUserSetEveningRows.mockResolvedValue([
      {
        ticketId: "WO-123",
        eveningRtplStatus: "Case-Closed",
        eveningUpdatedAt: "2026-05-26 17:00:00+05:30",
      },
    ]);
    // Engineer edited at 18:00 (so updated_at is 18:00), Evening never touched.
    mocks.findDailyCallPlanReportRowMetadataByReportId.mockResolvedValue([
      {
        id: "row-1",
        serialNo: 1,
        ticketId: "WO-123",
        caseCreatedTime: null,
        wipAging: "1",
        statusAging: null,
        hpOwnerStatus: null,
        rtplStatus: "Scheduled",
        eveningRtplStatus: null,
        segment: "",
        engineer: "Newly assigned",
        location: null,
        customerMail: null,
        rca: null,
        remarks: null,
        manualNotes: null,
        carriedForwardFields: [],
        manualFieldsCompleted: false,
        manualFieldsMissing: [],
        updatedAt: "2026-05-26 18:00:00+05:30",
        eveningUpdatedAt: null,
        updatedBy: "user-1",
        isExcluded: false,
      },
    ]);
    mocks.findOrCreateCompletedHistorySessionForReport.mockResolvedValue({
      id: "session-1",
    });
    mocks.findPreviousCompletedComparisonSession.mockResolvedValue(null);

    const report = await generateDailyCallPlanReport({
      reportDate: "2026-05-26",
      generatedBy: "user-1",
      regionId: null,
      flexUploadBatchId: "batch-flex",
      allowCreate: false,
    });

    expect(report.rows[0]?.enriched.evening_rtpl_status).toBe("Case-Closed");
    expect(mocks.adoptReportRowEveningStatusFromAuthority).toHaveBeenCalledWith(client, {
      rowId: "row-1",
      eveningRtplStatus: "Case-Closed",
      authorityEveningUpdatedAt: "2026-05-26 17:00:00+05:30",
    });
  });

  // Regression for the 2026-07-23 mass-close: regenerating an EXISTING report
  // from a REGION-SCOPED Flex batch used to run unrestricted, so every other
  // region's carried ticket was "absent from Flex" -> persisted as CLOSED.
  // The batch's own region must scope the regeneration: out-of-scope tickets
  // are carried forward verbatim, never closed.
  it("a region-scoped Flex batch never closes other regions' carried tickets", async () => {
    const { generateDailyCallPlanReport } = await import("./dailyCallPlanGenerator.js");
    const client = {} as PoolClient;

    mocks.withTransaction.mockImplementation(async (callback) => callback(client));
    mocks.validateReportGenerationTransaction.mockResolvedValue("report-1");
    mocks.findFlexWipRecordsByBatchId.mockResolvedValue([{ ticketId: "WO-123", rowNumber: 1 }]);
    mocks.findRenderwaysRecordsByBatchId.mockResolvedValue([]);
    mocks.findCallPlanRecordsByBatchId.mockResolvedValue([]);
    mocks.findActiveSlaHoursByCategory.mockResolvedValue(new Map());
    mocks.findAreaNameByPincode.mockResolvedValue(new Map());
    mocks.findRegionOfficesByAspCode.mockResolvedValue(new Map());
    mocks.findPincodeCoordinates.mockResolvedValue(new Map());
    mocks.findRoadDistances.mockResolvedValue(new Map());

    // The file only covers Chennai (ASPS01461) — it is a region-scoped upload.
    mocks.findUploadBatchesForValidation.mockResolvedValue([
      { id: "batch-flex", regionId: "region-chn" },
    ]);
    mocks.findRegionById.mockResolvedValue({
      id: "region-chn",
      code: "CHN",
      name: "Chennai",
      isActive: true,
      createdAt: "",
    });

    const inScope = currentMatch();
    inScope.enrichedRow.work_location = "ASPS01461";

    const chennaiPrevious = previousFinalRow();
    chennaiPrevious.workLocation = "ASPS01461";
    chennaiPrevious.manualValues = { ...chennaiPrevious.manualValues };

    // A Hosur ticket carried from the previous report — absent from the
    // Chennai file, and that absence must NOT close it.
    const hosurPrevious = previousFinalRow();
    hosurPrevious.ticketId = "WO-999";
    hosurPrevious.workLocation = "ASPS01511";
    hosurPrevious.rtplStatus = "Scheduled";
    hosurPrevious.manualValues = {
      ...hosurPrevious.manualValues,
      rtpl_status: "Scheduled",
    };

    mocks.matchSourceRecords.mockReturnValue([inScope]);
    mocks.findPreviousFinalReportRowsForManualCarryForward.mockResolvedValue([
      chennaiPrevious,
      hosurPrevious,
    ]);
    mocks.findFlexStatusHistoryForUnchangedDays.mockResolvedValue([]);
    mocks.findDailyCallPlanReportRowMetadataByReportId.mockResolvedValue([]);
    mocks.findOrCreateCompletedHistorySessionForReport.mockResolvedValue({
      id: "session-1",
    });
    mocks.findPreviousCompletedComparisonSession.mockResolvedValue(null);

    const report = await generateDailyCallPlanReport({
      reportDate: "2026-05-26",
      generatedBy: "user-1",
      regionId: null,
      flexUploadBatchId: "batch-flex",
      allowCreate: false,
    });

    const hosurRow = report.rows.find((row) => row.enriched.ticket_id === "WO-999");
    expect(hosurRow).toBeDefined();
    expect(hosurRow?.carryForward.closedSyntheticRow).toBe(false);
    expect(hosurRow?.carryForward.sameDayClosedRow).toBe(false);
    expect(hosurRow?.carryForward.changeType).not.toBe("CLOSED");
    expect(hosurRow?.enriched.rtpl_status).toBe("Scheduled");

    const chennaiRow = report.rows.find((row) => row.enriched.ticket_id === "WO-123");
    expect(chennaiRow?.carryForward.closedSyntheticRow).toBe(false);
  });
});
