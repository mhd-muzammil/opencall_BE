import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EditedReportRow,
  ReportRowEditPayload,
} from "../../repositories/dailyCallPlanReportRepository.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { updateReportRowManualFields } from "./reportRowEditService.js";

const mocks = vi.hoisted(() => ({
  findDailyCallPlanReportRowForEdit: vi.fn(),
  updateDailyCallPlanReportRowManualFields: vi.fn(),
  deleteDailyCallPlanReportRow: vi.fn(),
  findRegionById: vi.fn(),
}));

vi.mock("../../repositories/dailyCallPlanReportRepository.js", () => ({
  findDailyCallPlanReportRowForEdit: mocks.findDailyCallPlanReportRowForEdit,
  updateDailyCallPlanReportRowManualFields:
    mocks.updateDailyCallPlanReportRowManualFields,
  deleteDailyCallPlanReportRow: mocks.deleteDailyCallPlanReportRow,
}));

vi.mock("../../repositories/regionRepository.js", () => ({
  findRegionById: mocks.findRegionById,
}));

const superAdmin: AuthenticatedUser = {
  id: "user-1",
  email: "admin@example.com",
  username: "admin",
  role: "SUPER_ADMIN",
  regionId: null,
  region_id: null,
  mustChangePassword: false,
  accessibleSections: null,
};

function editedRow(overrides: Partial<EditedReportRow> = {}): EditedReportRow {
  return {
    id: "row-1",
    reportId: "report-1",
    serialNo: 7,
    ticketId: "WO-700",
    caseId: "CASE-700",
    regionId: "region-1",
    workLocation: "ASPS01461",
    caseCreatedTime: null,
    wipAging: "6",
    statusAging: "3",
    hpOwnerStatus: "Open",
    engineer: "Priya",
    rtplStatus: "Actionable",
    eveningRtplStatus: null,
    customerMail: "customer@example.com",
    rca: "Awaiting part",
    remarks: null,
    manualNotes: null,
    location: "Chennai",
    segment: "Commercial",
    part: null,
    customerName: null,
    carriedForwardFields: ["rtpl_status", "status_aging"],
    manualFieldsCompleted: true,
    manualFieldsMissing: [],
    updatedAt: "2026-06-02T08:45:00.000Z",
    updatedBy: "user-1",
    rowEditable: true,
    carryForwardSource: "PREVIOUS_FINAL_REPORT",
    ...overrides,
  };
}

describe("updateReportRowManualFields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an RTPL status change when the saved status changes", async () => {
    const current = editedRow();
    const updated = editedRow({
      rtplStatus: "Need to Cancel",
      carriedForwardFields: ["status_aging"],
      updatedAt: "2026-06-02T08:46:00.000Z",
    });
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(current);
    mocks.updateDailyCallPlanReportRowManualFields.mockResolvedValue(updated);

    const result = await updateReportRowManualFields({
      rowId: "row-1",
      user: superAdmin,
      values: { rtplStatus: "Need to Cancel" },
    });

    expect(result.rtplStatusChange).toEqual({
      rowId: "row-1",
      reportId: "report-1",
      serialNo: 7,
      ticketId: "WO-700",
      caseId: "CASE-700",
      workLocation: "ASPS01461",
      fromStatus: "Actionable",
      toStatus: "Need to Cancel",
      changedAt: "2026-06-02T08:46:00.000Z",
      changedBy: "user-1",
    });

    const [, payload] = mocks.updateDailyCallPlanReportRowManualFields.mock
      .calls[0] as [string, ReportRowEditPayload];
    expect(payload.statusAging).toBe("3");
    expect(payload.clearedCarryForwardFields).toEqual(["rtpl_status"]);
  });

  it("does not create an RTPL change entry for no-op or non-RTPL edits", async () => {
    const current = editedRow();
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(current);
    mocks.updateDailyCallPlanReportRowManualFields.mockResolvedValue(current);

    const noOpResult = await updateReportRowManualFields({
      rowId: "row-1",
      user: superAdmin,
      values: { rtplStatus: " Actionable " },
    });
    expect(noOpResult.rtplStatusChange).toBeNull();

    const engineerOnlyResult = await updateReportRowManualFields({
      rowId: "row-1",
      user: superAdmin,
      values: { engineer: "Mike" },
    });
    expect(engineerOnlyResult.rtplStatusChange).toBeNull();
  });
});
