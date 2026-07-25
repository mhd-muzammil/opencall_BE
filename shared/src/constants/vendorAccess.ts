import type { VendorAccessPermissionLevel } from "../types/rbac.js";

/**
 * The vendor-portal "views" a Vendor Access login can be granted. Unlike special-access
 * sections (which reuse the operational workspace views over region-scoped data), these
 * are vendor-specific views over ONLY the cases assigned to that vendor.
 */
export interface VendorAccessSectionOption {
  key: string;
  label: string;
  group: string;
}

export const VENDOR_ACCESS_SECTIONS: readonly VendorAccessSectionOption[] = [
  { key: "my-cases", label: "My Cases", group: "Vendor" },
  { key: "cases-summary", label: "Cases Summary", group: "Vendor" },
  { key: "closed-cases", label: "Closed Cases", group: "Vendor" },
  { key: "activity", label: "Activity", group: "Vendor" },
];

export const VENDOR_ACCESS_SECTION_KEYS: readonly string[] =
  VENDOR_ACCESS_SECTIONS.map((section) => section.key);

export function isVendorAccessSectionKey(value: string): boolean {
  return VENDOR_ACCESS_SECTION_KEYS.includes(value);
}

export const VENDOR_ACCESS_PERMISSION_LEVELS: readonly {
  value: VendorAccessPermissionLevel;
  label: string;
  description: string;
}[] = [
  { value: "view", label: "View only", description: "See assigned cases; cannot change them" },
  { value: "update", label: "Update", description: "May update status / remarks on their own assigned cases" },
];

export const VENDOR_ACCESS_PERMISSION_LEVEL_VALUES: readonly VendorAccessPermissionLevel[] =
  VENDOR_ACCESS_PERMISSION_LEVELS.map((option) => option.value);
