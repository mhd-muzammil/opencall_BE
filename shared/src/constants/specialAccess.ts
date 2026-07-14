import type {
  SpecialAccessDataScope,
  SpecialAccessPermissionLevel,
} from "../types/rbac.js";

/**
 * The operational app "sections" (the `workspaceView` values in the web app) that a
 * special-access credential can be granted. Admin-only embedded views (add engineers,
 * rtpl-status management) are intentionally excluded — special access is for operational
 * pages only.
 */
export interface SpecialAccessSectionOption {
  key: string;
  label: string;
  group: string;
}

export const SPECIAL_ACCESS_SECTIONS: readonly SpecialAccessSectionOption[] = [
  { key: "overview", label: "Overview", group: "Dashboards" },
  { key: "closed-calls", label: "Closed Calls", group: "Dashboards" },
  { key: "rtpl-dashboard", label: "RTPL Dashboard", group: "Dashboards" },
  { key: "rtpl", label: "RTPL Hours Status", group: "Dashboards" },
  { key: "sla-tat", label: "SLA TaT", group: "Dashboards" },
  { key: "pivot", label: "RTPL Pivot", group: "Dashboards" },
  { key: "tn-view-status", label: "TN View Status", group: "Dashboards" },
  { key: "flex", label: "Flex Dashboard", group: "Dashboards" },
  { key: "flex-eod-bod", label: "Flex EOD & BOD", group: "Dashboards" },
  { key: "records", label: "Records Table", group: "Data & Operations" },
  { key: "record-format", label: "Record Format", group: "Data & Operations" },
  { key: "productivity", label: "Engineer Productivity", group: "Dashboards" },
];

export const SPECIAL_ACCESS_SECTION_KEYS: readonly string[] =
  SPECIAL_ACCESS_SECTIONS.map((section) => section.key);

export function isSpecialAccessSectionKey(value: string): boolean {
  return SPECIAL_ACCESS_SECTION_KEYS.includes(value);
}

export const SPECIAL_ACCESS_DATA_SCOPES: readonly {
  value: SpecialAccessDataScope;
  label: string;
  description: string;
}[] = [
  { value: "overall", label: "Overall", description: "All active cases" },
  { value: "warranty", label: "Warranty", description: "Excludes 01-Trade" },
  { value: "trade", label: "Trade", description: "01-Trade / non-warranty" },
];

export const SPECIAL_ACCESS_PERMISSION_LEVELS: readonly {
  value: SpecialAccessPermissionLevel;
  label: string;
  description: string;
}[] = [
  { value: "view", label: "View only", description: "Read dashboards; cannot edit, upload or generate" },
  { value: "edit", label: "Edit", description: "May edit report rows, upload and generate" },
];

export const SPECIAL_ACCESS_DATA_SCOPE_VALUES: readonly SpecialAccessDataScope[] =
  SPECIAL_ACCESS_DATA_SCOPES.map((option) => option.value);

export const SPECIAL_ACCESS_PERMISSION_LEVEL_VALUES: readonly SpecialAccessPermissionLevel[] =
  SPECIAL_ACCESS_PERMISSION_LEVELS.map((option) => option.value);
