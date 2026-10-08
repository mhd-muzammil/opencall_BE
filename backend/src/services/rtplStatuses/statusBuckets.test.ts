import { afterEach, describe, expect, it } from "vitest";
import {
  classifyProductivityStatus,
  isActionableStatus,
  isAttendedOutcomeStatus,
  lockedStatusBucket,
  setStatusBucketMap,
  statusInBodEodRow,
  suggestStatusBucket,
} from "@opencall/shared";

afterEach(() => {
  setStatusBucketMap([]);
});

describe("suggestStatusBucket — the backfill for statuses that predate the column", () => {
  it.each([
    ["Scheduled", "SCHEDULED"],
    ["Engg Assigned", "SCHEDULED"],
    ["To be Scheduled", "TO_BE_SCHEDULE"],
    ["Engg Assignment Pending", "TO_BE_SCHEDULE"],
    ["Onsite", "ONSITE"],
    ["Customer Pending", "CX_RESCHEDULE"],
    ["CX Pending", "CX_RESCHEDULE"],
    ["Engineer Delay", "ENGINEER_DELAY"],
    ["SSC Pending → Part Pending", "SSC_PENDING"],
    ["Elevation Part Pending", "ELEVATE_TECH"],
    ["HP Pending", "ELEVATE_TECH"],
    ["under observation", "UNDER_OBSERVATION"],
    ["CRT Pending", "UNDER_OBSERVATION"],
    ["Need to Yank", "TO_BE_YANK"],
    ["Part Order Pending", "ADD_PART_ORDERED"],
    ["Need to Cancel Mail", "TO_BE_CANCEL"],
    ["Case-closed", "CLOSED"],
    ["WO-closed", "CLOSED"],
    ["Closed-cancellation", "OTHER"],
    ["Visit Estimate", "OTHER"],
  ])("%s -> %s", (name, bucket) => {
    expect(suggestStatusBucket(name)).toBe(bucket);
  });
});

describe("statusInBodEodRow", () => {
  it("a mapped status counts under exactly the row the admin chose", () => {
    setStatusBucketMap([{ name: "Waiting on Client", bucket: "CX_RESCHEDULE" }]);
    expect(statusInBodEodRow("Waiting on Client", "CX_RESCHEDULE")).toBe(true);
    expect(statusInBodEodRow("waiting on client ", "CX_RESCHEDULE")).toBe(true);
    expect(statusInBodEodRow("Waiting on Client", "TO_BE_SCHEDULE")).toBe(false);
  });

  it("the stored row beats the keywords in the name", () => {
    // "cx" alone used to drag any status containing it into Cx Reschedule.
    setStatusBucketMap([{ name: "CX Visit Done", bucket: "OTHER" }]);
    expect(statusInBodEodRow("CX Visit Done", "CX_RESCHEDULE")).toBe(false);
  });

  it("text that is not in the admin list keeps the old keyword rules", () => {
    setStatusBucketMap([{ name: "Scheduled", bucket: "SCHEDULED" }]);
    expect(statusInBodEodRow("ssc pedning", "SSC_PENDING")).toBe(true);
    expect(statusInBodEodRow("Elevation- HP Pending", "ELEVATE_TECH")).toBe(false);
    expect(statusInBodEodRow("Elevate - tech", "ELEVATE_TECH")).toBe(true);
  });

  it("blank and placeholder statuses count nowhere", () => {
    setStatusBucketMap([{ name: "Manual Entry Required", bucket: "OTHER" }]);
    expect(statusInBodEodRow("", "OTHER")).toBe(false);
    expect(statusInBodEodRow("Manual Entry Required", "OTHER")).toBe(false);
  });

  it("ignores entries without a valid bucket", () => {
    setStatusBucketMap([{ name: "Customer Pending", bucket: null }, { name: "X", bucket: "NOPE" }]);
    expect(statusInBodEodRow("Customer Pending", "CX_RESCHEDULE")).toBe(true);
    expect(statusInBodEodRow("X", "OTHER")).toBe(false);
  });
});

describe("isActionableStatus", () => {
  it("is Scheduled plus whatever the admin put under To be Schedule", () => {
    setStatusBucketMap([
      { name: "Scheduled", bucket: "SCHEDULED" },
      { name: "Engg Assignment Pending", bucket: "TO_BE_SCHEDULE" },
      { name: "Engg Assigned", bucket: "SCHEDULED" },
    ]);
    expect(isActionableStatus("Scheduled")).toBe(true);
    expect(isActionableStatus("Engg Assignment Pending")).toBe(true);
    expect(isActionableStatus("Engg Assigned")).toBe(false);
  });

  it("unmapped text keeps the old exact test", () => {
    expect(isActionableStatus("To Be Scheduled")).toBe(true);
    expect(isActionableStatus("Engg Assignment Pending")).toBe(false);
  });
});

describe("Engineer Productivity follows the same mapping", () => {
  it("a new status counts where the admin put it, not as Attended", () => {
    expect(classifyProductivityStatus("Waiting on Client")).toBe("ATTENDED_OTHER");
    setStatusBucketMap([{ name: "Waiting on Client", bucket: "CX_RESCHEDULE" }]);
    expect(classifyProductivityStatus("Waiting on Client")).toBe("CX_RESCHEDULE");
    expect(isAttendedOutcomeStatus("Waiting on Client")).toBe(false);
  });

  it.each([
    ["SSC_PENDING", "PART_ORDER"],
    ["ADD_PART_ORDERED", "PART_ORDER"],
    ["ELEVATE_TECH", "UNDER_OBSERVATION"],
    ["TO_BE_SCHEDULE", "SCHEDULED"],
    ["CLOSED", "CLOSED"],
    ["TO_BE_YANK", "ATTENDED_OTHER"],
  ])("%s -> %s", (bucket, productivity) => {
    setStatusBucketMap([{ name: "Some Status", bucket }]);
    expect(classifyProductivityStatus("Some Status")).toBe(productivity);
  });

  it("every existing status keeps its productivity bucket after the backfill", () => {
    const names = [
      "Scheduled", "Customer Pending", "Problem Resolution", "Onsite", "under observation",
      "To be Scheduled", "Engg Assignment Pending", "Engg Assigned", "Part Order Pending",
      "Additional Part", "Good Part Received", "SSC Pending", "Part Quote Shared",
      "Need to Cancel", "Need to Close", "Case-closed", "WO-closed", "Closed-cancellation",
      "Need to Yank", "HP Pending", "Elevation Part Pending", "Engineer Delay",
    ];
    const before = names.map((n) => classifyProductivityStatus(n));
    setStatusBucketMap(names.map((name) => ({ name, bucket: suggestStatusBucket(name) })));
    expect(names.map((n) => classifyProductivityStatus(n))).toEqual(before);
  });
});

describe("lockedStatusBucket", () => {
  it("pins the statuses other code matches by exact name", () => {
    expect(lockedStatusBucket("Scheduled")).toBe("SCHEDULED");
    expect(lockedStatusBucket("customer pending")).toBe("CX_RESCHEDULE");
    expect(lockedStatusBucket("Case-Closed")).toBe("CLOSED");
    expect(lockedStatusBucket("To be Scheduled")).toBeNull();
    expect(lockedStatusBucket("Need to Close")).toBeNull();
  });
});
