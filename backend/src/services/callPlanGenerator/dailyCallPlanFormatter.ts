import {
  DAILY_CALL_PLAN_COLUMNS,
  type DailyCallPlanColumn,
} from "@opencall/shared";
import type { EnrichedCallPlanRow } from "../../types/matching.js";
import type { DailyCallPlanOutputRow } from "../../types/reportGeneration.js";

export const MANUAL_ENTRY_REQUIRED = "Manual Entry Required";

function valueOrEmpty(value: string | number | null | undefined): string | number {
  return value ?? "";
}

function valueOrManual(value: string | number | null | undefined): string | number {
  if (value === null || value === undefined || value === "") {
    return MANUAL_ENTRY_REQUIRED;
  }

  return value;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDisplayDateTime(
  value: string | number | null | undefined,
): string | number {
  if (value === null || value === undefined || value === "") {
    return MANUAL_ENTRY_REQUIRED;
  }

  if (typeof value === "number") {
    return value;
  }

  const normalizedValue = value.includes(" ") && /[+-]\d{2}:?\d{2}$/.test(value)
    ? value.replace(" ", "T")
    : value;
  const date = new Date(normalizedValue);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const partValue = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const hour = pad2(Number(partValue("hour")));
  const dayPeriod = partValue("dayPeriod").toUpperCase();

  return `${partValue("day")}-${partValue("month")}-${partValue("year")} ${hour}:${partValue("minute")}:${partValue("second")} ${dayPeriod}`;
}

export function formatDailyCallPlanRow(
  serialNo: number,
  row: EnrichedCallPlanRow,
): DailyCallPlanOutputRow {
  return {
    "S.no": serialNo,
    "Ticket ID": valueOrEmpty(row.ticket_id),
    "Case ID": valueOrManual(row.case_id),
    "Case Created Time": formatDisplayDateTime(row.case_created_time),
    "WIP aging": valueOrEmpty(row.wip_aging),
    "RTPL status": valueOrManual(row.rtpl_status),
    Segment: valueOrManual(row.segment),
    Engineer: valueOrManual(row.engineer),
    Product: valueOrEmpty(row.product),
    "Product Line Name": valueOrEmpty(row.product_line_name),
    "Work Location": valueOrEmpty(row.work_location),
    "Flex Status": valueOrEmpty(row.flex_status),
    "HP Owner Status": valueOrManual(row.hp_owner_status),
    "WO OTC CODE": valueOrManual(row.wo_otc_code),
    "Account Name": valueOrManual(row.account_name),
    "Customer Name": valueOrEmpty(row.customer_name),
    Location: valueOrManual(row.location),
    Contact: valueOrEmpty(row.contact),
    Part: valueOrEmpty(row.part),
    "WIP Aging Category": valueOrManual(row.wip_aging_category),
    TAT: valueOrManual(row.tat),
    "Customer Mail": valueOrManual(row.customer_mail),
    RCA: valueOrManual(row.rca),
  };
}

export function orderedDailyCallPlanRow(
  row: DailyCallPlanOutputRow,
): DailyCallPlanOutputRow {
  return DAILY_CALL_PLAN_COLUMNS.reduce((ordered, column) => {
    ordered[column] = row[column];
    return ordered;
  }, {} as Record<DailyCallPlanColumn, string | number>);
}
