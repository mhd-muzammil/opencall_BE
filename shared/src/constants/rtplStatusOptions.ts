// Common RTPL status values for the dropdown.
// The "Custom" option allows manual entry of any other value.

export const RTPL_STATUS_GROUPS = [
  {
    group: "General Activity",
    options: ["Actionable", "CX Pending", "Problem Resolution", "work in progress", "under observation"]
  },
  {
    group: "Scheduling & Engineer",
    options: ["To be Scheduled", "Engg Assignment Pending", "Engg Assigned"]
  },
  {
    group: "Parts & Inventory",
    options: ["Part Order Pending", "Additional Part", "Good Part Received", "SSC Pending → Part Pending"]
  },
  {
    group: "Quotations & Payments",
    options: ["Part Quotation Pending", "Part Quote Shared", "Part Payment Received"]
  },
  {
    group: "Visitation & Estimates",
    options: ["Visit Estimate", "Visit Quote to Customer", "Visitation Accepted", "Visitation Rejected"]
  },
  {
    group: "Cancellations & Closures",
    options: ["Need to Cancel", "Need to Cancel Mail", "Need to Close", "OTP", "WO-closed", "Closed-cancellation"]
  },
  {
    group: "Returns & Yank",
    options: ["Need to Yank", "Yank"]
  },
  {
    group: "Elevations / Escalations",
    options: ["Elevation HP Pending", "Elevation Part Pending"]
  },
  {
    group: "Validation & Testing",
    options: ["CRT Pending", "CT Validation Pending"]
  }
] as const;

export const RTPL_STATUS_OPTIONS = RTPL_STATUS_GROUPS.flatMap((g) => g.options);

export type RTPLStatusOption = (typeof RTPL_STATUS_OPTIONS)[number];
