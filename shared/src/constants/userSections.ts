/**
 * Operational app "sections" (the `workspaceView` values in the web app) that a
 * REGION_ADMIN user's access can be scoped to from the Admin Console.
 *
 * Opt-OUT model: a user with `accessibleSections = null` sees every section (the previous
 * behaviour); a non-null list restricts them to exactly those keys. SUPER_ADMIN ignores
 * this entirely and always sees everything.
 *
 * This mirrors the special-access section set and adds Warranty Lookup (which regular
 * users have but special-access does not). Admin-only embedded views (Add Engineers,
 * RTPL Statuses) are intentionally excluded — those stay role-gated as before.
 */
export interface UserSectionOption {
  key: string;
  label: string;
  group: string;
}

export const USER_SECTIONS: readonly UserSectionOption[] = [
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
  { key: "warranty", label: "Warranty Lookup", group: "Data & Operations" },
  { key: "productivity", label: "Engineer Productivity", group: "Dashboards" },
];

export const USER_SECTION_KEYS: readonly string[] = USER_SECTIONS.map(
  (section) => section.key,
);

export function isUserSectionKey(value: string): boolean {
  return USER_SECTION_KEYS.includes(value);
}
