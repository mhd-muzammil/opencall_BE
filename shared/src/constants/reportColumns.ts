// Daily Call Plan Report output columns.
// Order is strict and must never be changed without a migration/version update.
export const DAILY_CALL_PLAN_COLUMNS = [
  "S.no",
  "Ticket ID",
  "Case ID",
  "Segment",
  "WIP aging",
  "Location",
  "RTPL status",
  "Evening status",
  "Current Remarks",
  "Engineer",
  "Flex Status",
  "Status Aging",
  "HP Owner Status",
  "Part",
  "Product Name",
  "Product S.No",
  "Product Line Name",
  "Work Location",
  "WO OTC CODE",
  "Account Name",
  "Customer Name",
  "Contact",
  "WIP Aging Category",
  "TAT",
  "Customer Mail",
  "RCA",
  "Case Created Time",
  // Appended, never inserted: the order above is persisted in saved user
  // layouts and in every exported workbook, so an insertion would silently
  // reshuffle both. New columns go on the end.
  "Distance",
] as const;

export type DailyCallPlanColumn = (typeof DAILY_CALL_PLAN_COLUMNS)[number];
