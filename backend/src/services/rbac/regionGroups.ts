import { ASP_CODE_REGION_MAP } from "@opencall/shared";
import type { Region } from "../../repositories/regionRepository.js";

/**
 * Region records can be duplicated by name in the `regions` table (e.g.
 * "Chennai" exists both as code "ASPS01461" and as code "CHN"). Code that
 * groups by region — region scoping, dashboards, drill-downs — must treat
 * those as a single canonical region or callers will see duplicate
 * dropdown entries, double-counted tiles, and inconsistent filtering.
 *
 * The helpers in this module are the single source of truth for collapsing
 * those duplicates and resolving a canonical region for an arbitrary work
 * location (ASP code) coming off a report row.
 */

export interface RegionGroup {
  /**
   * The preferred Region record for the group. When duplicates exist we
   * prefer the one whose code matches the ASP code pattern, then any active
   * record, then the first record we saw.
   */
  canonical: Region;
  /**
   * Every `regions.id` belonging to the same canonical region. Useful when
   * a downstream query keys off region_id (e.g. activity log, reports).
   */
  regionIds: Set<string>;
}

const ASP_CODE_PATTERN = /^ASPS\d+$/i;

function canonicalNameKey(region: Region): string {
  return region.name.trim().toUpperCase();
}

export function dedupeRegionsByName(regions: readonly Region[]): RegionGroup[] {
  const grouped = new Map<string, Region[]>();
  for (const region of regions) {
    const key = canonicalNameKey(region);
    const list = grouped.get(key) ?? [];
    list.push(region);
    grouped.set(key, list);
  }

  const result: RegionGroup[] = [];
  for (const list of grouped.values()) {
    const canonical =
      list.find((r) => ASP_CODE_PATTERN.test(r.code)) ??
      list.find((r) => r.isActive) ??
      list[0]!;
    result.push({
      canonical,
      regionIds: new Set(list.map((r) => r.id)),
    });
  }
  return result.sort((a, b) => a.canonical.name.localeCompare(b.canonical.name));
}

export interface CanonicalRegionRef {
  /** Canonical region name (upper-cased, matching ASP_CODE_REGION_MAP). */
  name: string;
  /** ASP code from the row's work_location if it resolved cleanly, else null. */
  aspCode: string | null;
}

/**
 * Resolves the canonical region for a row using its work_location (ASP code)
 * first, falling back to the report's region_id join. This avoids the
 * Chennai-duplicate problem at row level: even if a row came from a report
 * whose region_id is the secondary Chennai record, the work_location ASP
 * code still maps to the single canonical region.
 */
export function canonicalRegionForRow(
  workLocation: string | null | undefined,
  reportRegionName: string | null | undefined,
): CanonicalRegionRef {
  const aspCode = (workLocation ?? "").trim().toUpperCase();
  if (aspCode && ASP_CODE_REGION_MAP[aspCode]) {
    return { name: ASP_CODE_REGION_MAP[aspCode]!, aspCode };
  }
  const fallback = (reportRegionName ?? "").trim().toUpperCase();
  if (fallback) {
    return { name: fallback, aspCode: null };
  }
  return { name: "UNKNOWN", aspCode: null };
}
