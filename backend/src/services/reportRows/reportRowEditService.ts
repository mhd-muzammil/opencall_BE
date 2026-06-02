import type { AuthenticatedUser } from "../../types/auth.js";
import type { ManualCarryForwardField } from "../../types/reportGeneration.js";
import {
  MANUAL_CARRY_FORWARD_FIELDS,
  OPTIONAL_MANUAL_CARRY_FORWARD_FIELDS,
} from "../../types/reportGeneration.js";
import {
  findDailyCallPlanReportRowForEdit,
  updateDailyCallPlanReportRowManualFields,
  deleteDailyCallPlanReportRow,
  type EditedReportRow,
  type RtplStatusChange,
} from "../../repositories/dailyCallPlanReportRepository.js";
import { findRegionById } from "../../repositories/regionRepository.js";
import { workLocationMatchesRegion } from "../rbac/regionRowAccess.js";
import { forbidden, unprocessableEntity } from "../../utils/httpError.js";

export const EDITABLE_REPORT_ROW_FIELDS = [
  "engineer",
  "rtplStatus",
  "customerMail",
  "rca",
  "remarks",
  "manualNotes",
  "location",
  "segment",
  "caseCreatedTime",
  "wipAging",
  "statusAging",
  "hpOwnerStatus",
] as const;

export type EditableReportRowField =
  (typeof EDITABLE_REPORT_ROW_FIELDS)[number];

export type ReportRowEditInput = Partial<
  Record<EditableReportRowField, string | null>
>;

const REQUIRED_MANUAL_FIELD_VALUE_BY_RESPONSE_FIELD: Record<
  (typeof MANUAL_CARRY_FORWARD_FIELDS)[number],
  keyof Pick<
    EditedReportRow,
    | "rtplStatus"
    | "segment"
    | "engineer"
    | "location"
    | "caseCreatedTime"
    | "wipAging"
    | "statusAging"
    | "hpOwnerStatus"
    | "customerMail"
    | "rca"
  >
> = {
  rtpl_status: "rtplStatus",
  segment: "segment",
  engineer: "engineer",
  location: "location",
  case_created_time: "caseCreatedTime",
  status_aging: "statusAging",
  hp_owner_status: "hpOwnerStatus",
  customer_mail: "customerMail",
  rca: "rca",
};

const OPTIONAL_FIELD_VALUE_BY_RESPONSE_FIELD: Record<
  (typeof OPTIONAL_MANUAL_CARRY_FORWARD_FIELDS)[number],
  keyof Pick<EditedReportRow, "remarks" | "manualNotes">
> = {
  remarks: "remarks",
  manual_notes: "manualNotes",
};

const MANUAL_FIELD_BY_EDITABLE_FIELD: Partial<
  Record<EditableReportRowField, ManualCarryForwardField>
> = {
  engineer: "engineer",
  rtplStatus: "rtpl_status",
  customerMail: "customer_mail",
  rca: "rca",
  remarks: "remarks",
  manualNotes: "manual_notes",
  location: "location",
  segment: "segment",
  caseCreatedTime: "case_created_time",
  statusAging: "status_aging",
  hpOwnerStatus: "hp_owner_status",
};

const PLACEHOLDER_VALUES = new Set([
  "",
  "manual entry required",
  "n/a",
  "na",
  "not applicable",
  "not available",
  "none",
  "null",
  "undefined",
  "-",
  "--",
]);

function cleanEditableValue(value: string | null | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  if (value === null) {
    return null;
  }

  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

function isCarryForwardValue(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return !PLACEHOLDER_VALUES.has(value.toLowerCase());
}

function manualFieldsMissing(values: EditedReportRow): ManualCarryForwardField[] {
  return MANUAL_CARRY_FORWARD_FIELDS.filter((field) => {
    const valueField = REQUIRED_MANUAL_FIELD_VALUE_BY_RESPONSE_FIELD[field];
    return !isCarryForwardValue(values[valueField]);
  });
}

function mergeRowValues(
  current: EditedReportRow,
  input: ReportRowEditInput,
): EditedReportRow {
  return {
    ...current,
    engineer:
      input.engineer === undefined ? current.engineer : cleanEditableValue(input.engineer),
    rtplStatus:
      input.rtplStatus === undefined
        ? current.rtplStatus
        : cleanEditableValue(input.rtplStatus),
    customerMail:
      input.customerMail === undefined
        ? current.customerMail
        : cleanEditableValue(input.customerMail),
    rca: input.rca === undefined ? current.rca : cleanEditableValue(input.rca),
    remarks:
      input.remarks === undefined ? current.remarks : cleanEditableValue(input.remarks),
    manualNotes:
      input.manualNotes === undefined
        ? current.manualNotes
        : cleanEditableValue(input.manualNotes),
    location:
      input.location === undefined ? current.location : cleanEditableValue(input.location),
    segment:
      input.segment === undefined ? current.segment : cleanEditableValue(input.segment),
    caseCreatedTime:
      input.caseCreatedTime === undefined
        ? current.caseCreatedTime
        : cleanEditableValue(input.caseCreatedTime),
    wipAging:
      input.wipAging === undefined ? current.wipAging : cleanEditableValue(input.wipAging),
    statusAging:
      input.statusAging === undefined ? current.statusAging : cleanEditableValue(input.statusAging),
    hpOwnerStatus:
      input.hpOwnerStatus === undefined
        ? current.hpOwnerStatus
        : cleanEditableValue(input.hpOwnerStatus),
  };
}

function hasEditedField(
  values: ReportRowEditInput,
  field: EditableReportRowField,
): boolean {
  return Object.prototype.hasOwnProperty.call(values, field);
}

function buildRtplStatusChange(
  current: EditedReportRow,
  updated: EditedReportRow,
  values: ReportRowEditInput,
): RtplStatusChange | null {
  if (!hasEditedField(values, "rtplStatus")) {
    return null;
  }

  const fromStatus = cleanEditableValue(current.rtplStatus);
  const toStatus = cleanEditableValue(updated.rtplStatus);

  if (fromStatus === toStatus) {
    return null;
  }

  return {
    rowId: updated.id,
    reportId: updated.reportId,
    serialNo: updated.serialNo,
    ticketId: updated.ticketId,
    caseId: updated.caseId,
    workLocation: updated.workLocation,
    fromStatus,
    toStatus,
    changedAt: updated.updatedAt,
    changedBy: updated.updatedBy,
  };
}

export function assertOnlyEditableFields(body: Record<string, unknown>): void {
  const editable = new Set<string>(EDITABLE_REPORT_ROW_FIELDS);
  const invalidFields = Object.keys(body).filter((field) => !editable.has(field));

  if (invalidFields.length > 0) {
    throw unprocessableEntity("Only manual operational fields can be edited", {
      invalidFields,
      editableFields: EDITABLE_REPORT_ROW_FIELDS,
    });
  }
}

export async function updateReportRowManualFields(input: {
  rowId: string;
  user: AuthenticatedUser;
  values: ReportRowEditInput;
}): Promise<EditedReportRow> {
  const current = await findDailyCallPlanReportRowForEdit(input.rowId);

  if (!current) {
    throw unprocessableEntity("Report row does not exist", {
      rowId: input.rowId,
    });
  }

  if (input.user.role !== "SUPER_ADMIN") {
    if (!input.user.regionId) {
      throw forbidden("REGION_ADMIN user is not assigned to a region");
    }
    const region = await findRegionById(input.user.regionId);
    if (!region) {
      throw forbidden("REGION_ADMIN user's region was not found", {
        userRegionId: input.user.regionId,
      });
    }
    if (!workLocationMatchesRegion(current.workLocation, region)) {
      throw forbidden("Cannot edit report rows from another region", {
        rowWorkLocation: current.workLocation,
        userRegionId: input.user.regionId,
      });
    }
  }

  const merged = mergeRowValues(current, input.values);
  const missing = manualFieldsMissing(merged);
  const clearedCarryForwardFields = Object.keys(input.values)
    .map((field) => MANUAL_FIELD_BY_EDITABLE_FIELD[field as EditableReportRowField])
    .filter((field): field is ManualCarryForwardField => Boolean(field));

  return updateDailyCallPlanReportRowManualFields(input.rowId, {
    engineer: merged.engineer,
    rtplStatus: merged.rtplStatus,
    customerMail: merged.customerMail,
    rca: merged.rca,
    remarks: merged.remarks,
    manualNotes: merged.manualNotes,
    location: merged.location,
    segment: merged.segment,
    caseCreatedTime: merged.caseCreatedTime,
    wipAging: merged.wipAging,
    statusAging: merged.statusAging,
    hpOwnerStatus: merged.hpOwnerStatus,
    clearedCarryForwardFields,
    manualFieldsCompleted: missing.length === 0,
    manualFieldsMissing: missing,
    updatedBy: input.user.id,
  }).then((updated) => {
    if (!updated) {
      throw unprocessableEntity("Report row could not be updated", {
        rowId: input.rowId,
      });
    }

    return {
      ...updated,
      rtplStatusChange: buildRtplStatusChange(current, updated, input.values),
    };
  });
}

export async function deleteReportRowService(input: {
  rowId: string;
  user: AuthenticatedUser;
}): Promise<void> {
  const current = await findDailyCallPlanReportRowForEdit(input.rowId);

  if (!current) {
    throw unprocessableEntity("Report row does not exist", {
      rowId: input.rowId,
    });
  }

  if (
    input.user.role !== "SUPER_ADMIN" &&
    current.regionId !== null &&
    current.regionId !== input.user.regionId
  ) {
    throw forbidden("Cannot delete report rows from another region", {
      rowRegionId: current.regionId,
      userRegionId: input.user.regionId,
    });
  }

  const success = await deleteDailyCallPlanReportRow(input.rowId, input.user.id);
  if (!success) {
    throw unprocessableEntity("Report row could not be deleted", {
      rowId: input.rowId,
    });
  }
}

export const OPTIONAL_REPORT_ROW_EDIT_FIELDS =
  OPTIONAL_FIELD_VALUE_BY_RESPONSE_FIELD;
