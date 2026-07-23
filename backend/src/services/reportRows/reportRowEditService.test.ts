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

describe("Feature A — scheduling requires an engineer + auto remark", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function lastPayload(): ReportRowEditPayload {
    const [, payload] = mocks.updateDailyCallPlanReportRowManualFields.mock
      .calls[0] as [string, ReportRowEditPayload];
    return payload;
  }

  it("rejects setting Morning status to Scheduled with no engineer (422)", async () => {
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(
      editedRow({ engineer: null }),
    );

    await expect(
      updateReportRowManualFields({
        rowId: "row-1",
        user: superAdmin,
        values: { rtplStatus: "Scheduled" },
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "You must assign an engineer before scheduling.",
    });
    // Never reached the DB write.
    expect(mocks.updateDailyCallPlanReportRowManualFields).not.toHaveBeenCalled();
  });

  it("rejects a placeholder engineer too (Manual Entry Required)", async () => {
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(
      editedRow({ engineer: "Manual Entry Required" }),
    );
    await expect(
      updateReportRowManualFields({
        rowId: "row-1",
        user: superAdmin,
        values: { eveningRtplStatus: "Scheduled" },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("sets Current Remarks to 'Scheduled on <today>' when engineer is present", async () => {
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(
      editedRow({ engineer: "Praveen", remarks: null }),
    );
    mocks.updateDailyCallPlanReportRowManualFields.mockImplementation(
      async (_id, payload) => editedRow({ remarks: payload.remarks ?? null }),
    );

    await updateReportRowManualFields({
      rowId: "row-1",
      user: superAdmin,
      values: { rtplStatus: "Scheduled" },
    });

    const payload = lastPayload();
    expect(payload.remarks).toMatch(/^Scheduled on \d{1,2}(st|nd|rd|th) [A-Z][a-z]+$/);
    // remarks is marked set so it is not treated as carried-forward.
    expect(payload.clearedCarryForwardFields).toContain("remarks");
  });

  it("assigning engineer + Scheduled together passes and sets the remark", async () => {
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(
      editedRow({ engineer: null }),
    );
    mocks.updateDailyCallPlanReportRowManualFields.mockImplementation(
      async (_id, payload) => editedRow({ remarks: payload.remarks ?? null }),
    );

    await updateReportRowManualFields({
      rowId: "row-1",
      user: superAdmin,
      values: { rtplStatus: "Scheduled", engineer: "Kumar" },
    });

    expect(lastPayload().remarks).toMatch(/^Scheduled on /);
  });

  it("does not fire on an unrelated edit of an already-scheduled row", async () => {
    // Row is already Scheduled with no engineer (legacy data); editing only RCA
    // must NOT 422 and must NOT overwrite remarks.
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(
      editedRow({ rtplStatus: "Scheduled", engineer: null, remarks: "keep me" }),
    );
    mocks.updateDailyCallPlanReportRowManualFields.mockImplementation(
      async (_id, payload) => editedRow({ remarks: payload.remarks ?? null }),
    );

    await updateReportRowManualFields({
      rowId: "row-1",
      user: superAdmin,
      values: { rca: "some note" },
    });

    expect(lastPayload().remarks).toBe("keep me");
  });
});

describe("KCI logging — moving a status to Customer Pending appends to the RCA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateDailyCallPlanReportRowManualFields.mockImplementation(
      async (_id, payload) => editedRow({ rca: payload.rca ?? null }),
    );
  });

  function lastPayload(): ReportRowEditPayload {
    const [, payload] = mocks.updateDailyCallPlanReportRowManualFields.mock
      .calls[0] as [string, ReportRowEditPayload];
    return payload;
  }

  it("Morning -> Customer Pending appends remarks + KCI Done to the RCA", async () => {
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(
      editedRow({
        rca: "Case Received on 9th July - active case",
        remarks: "part quote to be shared",
      }),
    );

    await updateReportRowManualFields({
      rowId: "row-1",
      user: superAdmin,
      values: { rtplStatus: "Customer Pending" },
    });

    const payload = lastPayload();
    expect(payload.rca).toBe(
      "Case Received on 9th July - active case - part quote to be shared - KCI Done",
    );
    // rca is marked set so it is not treated as carried-forward.
    expect(payload.clearedCarryForwardFields).toContain("rca");
  });

  it("Evening -> Customer Pending uses the remarks saved in the same edit", async () => {
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(
      editedRow({ rca: "Base RCA", remarks: null }),
    );

    await updateReportRowManualFields({
      rowId: "row-1",
      user: superAdmin,
      values: { eveningRtplStatus: "Customer Pending", remarks: "cu need to pay" },
    });

    expect(lastPayload().rca).toBe("Base RCA - cu need to pay - KCI Done");
  });

  it("appends just KCI Done when there are no remarks", async () => {
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(
      editedRow({ rca: "Base RCA", remarks: null }),
    );

    await updateReportRowManualFields({
      rowId: "row-1",
      user: superAdmin,
      values: { rtplStatus: "Customer Pending" },
    });

    expect(lastPayload().rca).toBe("Base RCA - KCI Done");
  });

  it("fires on the TRANSITION only: an already-Customer-Pending row is untouched", async () => {
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(
      editedRow({
        rtplStatus: "Customer Pending",
        rca: "Base RCA",
        remarks: "part quote to be shared",
      }),
    );

    // Re-saving the same status and editing other fields must not append.
    await updateReportRowManualFields({
      rowId: "row-1",
      user: superAdmin,
      values: { rtplStatus: "Customer Pending", location: "Chennai" },
    });

    expect(lastPayload().rca).toBe("Base RCA");
    expect(lastPayload().clearedCarryForwardFields).not.toContain("rca");
  });

  it("never stacks duplicates when the RCA already ends with the segment", async () => {
    mocks.findDailyCallPlanReportRowForEdit.mockResolvedValue(
      editedRow({
        rtplStatus: "Actionable",
        rca: "Base RCA - part quote to be shared - KCI Done",
        remarks: "part quote to be shared",
      }),
    );

    await updateReportRowManualFields({
      rowId: "row-1",
      user: superAdmin,
      values: { rtplStatus: "Customer Pending" },
    });

    expect(lastPayload().rca).toBe("Base RCA - part quote to be shared - KCI Done");
    expect(lastPayload().clearedCarryForwardFields).not.toContain("rca");
  });
});
