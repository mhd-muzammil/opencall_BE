import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { MatchedCallPlanRecord } from "../../types/matching.js";
import type { FinalReportManualCarryForwardRow } from "../../repositories/dailyCallPlanReportRepository.js";

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  validateReportGenerationTransaction: vi.fn(),
  findFlexWipRecordsByBatchId: vi.fn(),
  findRenderwaysRecordsByBatchId: vi.fn(),
  findCallPlanRecordsByBatchId: vi.fn(),
  findActiveSlaHoursByCategory: vi.fn(),
  findAreaNameByPincode: vi.fn(),
  matchSourceRecords: vi.fn(),
  findPreviousFinalReportRowsForManualCarryForward: vi.fn(),
  findFlexStatusHistoryForUnchangedDays: vi.fn(),
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
