import { describe, expect, it } from "vitest";
import {
  formatRemaining,
  parseSlaDetail,
  parseSlaEndTime,
  parseTicketList,
  secondsRemaining,
  ticketKey,
  type FieldezTicketRef,
} from "./fieldezSlaParse.js";

/**
 * The payloads below are the real ones, trimmed. WO-035640797 was walked through FieldEZ by
 * hand and its screen read "Within SLA · Commercial · ends 2026-08-31 18:00:00" — every
 * expectation here is checked against what a person actually saw, not against what the field
 * names suggest.
 */

const LIST_ROW = {
  id: 1044258,
  ft_ticket_no: "WO-035640797",
  bpName: "HP Break Fix",
  ft_worklocation_name: "ASPS01511",
  createTime: 1787675919855,
  ftTaskName: "Partner Parts Hold",
  small_text_atrb5: "5163861807",
  bpId: 2,
  ft_product_serial_no: "5CD429902V",
  hasPart: true,
};

const DETAIL = {
  page: 0,
  size: 0,
  id: 1044258,
  fc_customer_id: "WO-035640797_+9109994917600",
  ft_priority: "WO Priority 7",
  ftSla: "Commercial",
  ft_sla: "Within SLA",
  slaEndTime: 1788179400000,
};

const REF: FieldezTicketRef = {
  fieldezTicketId: 1044258,
  ticketNo: "WO-035640797",
  bpId: 2,
  caseId: "5163861807",
  taskName: "Partner Parts Hold",
};

describe("ticketKey", () => {
  it("reads one job written three ways as one job", () => {
    expect(ticketKey("WO-035640797")).toBe("WO035640797");
    expect(ticketKey("wo035640797")).toBe("WO035640797");
    expect(ticketKey(" WO-035640797 ")).toBe("WO035640797");
  });

  it("is empty for nothing", () => {
    expect(ticketKey("")).toBe("");
    expect(ticketKey(null)).toBe("");
  });
});

describe("parseSlaEndTime", () => {
  it("reads epoch milliseconds as the instant FieldEZ's own screen showed", () => {
    // 1788179400000 is what the API returned for the ticket whose page read
    // "SLA End Time 2026-08-31 18:00:00" in IST, which is 12:30 UTC.
    expect(parseSlaEndTime(1788179400000)?.toISOString()).toBe("2026-08-31T12:30:00.000Z");
  });

  it("accepts the same instant as a string, since the API is inconsistent elsewhere", () => {
    expect(parseSlaEndTime("1788179400000")?.toISOString()).toBe("2026-08-31T12:30:00.000Z");
  });

  it("reads seconds as seconds rather than as a date in 1970", () => {
    // A deadline silently placed in 1970 would read as long overdue — a plausible-looking
    // lie is worse than an empty column.
    expect(parseSlaEndTime(1788179400)?.toISOString()).toBe("2026-08-31T12:30:00.000Z");
  });

  it("is null when there is no SLA", () => {
    expect(parseSlaEndTime(null)).toBeNull();
    expect(parseSlaEndTime(0)).toBeNull();
    expect(parseSlaEndTime("")).toBeNull();
    expect(parseSlaEndTime("-")).toBeNull();
    expect(parseSlaEndTime(undefined)).toBeNull();
  });

  it("falls back to a formatted date string", () => {
    expect(parseSlaEndTime("2026-08-31T12:30:00.000Z")?.toISOString()).toBe(
      "2026-08-31T12:30:00.000Z",
    );
  });
});

describe("parseTicketList", () => {
  it("reads a bare array of rows", () => {
    const [ticket] = parseTicketList([LIST_ROW]);
    expect(ticket).toEqual({
      fieldezTicketId: 1044258,
      ticketNo: "WO-035640797",
      bpId: 2,
      caseId: "5163861807",
      taskName: "Partner Parts Hold",
    });
  });

  it("finds the rows inside a paging wrapper", () => {
    expect(parseTicketList({ page: 0, size: 20, data: [LIST_ROW] })).toHaveLength(1);
    expect(parseTicketList({ result: { content: [LIST_ROW] } })).toHaveLength(1);
  });

  it("skips rows with no work order or no id", () => {
    expect(parseTicketList([{ ...LIST_ROW, ft_ticket_no: "" }])).toHaveLength(0);
    expect(parseTicketList([{ ...LIST_ROW, id: null }])).toHaveLength(0);
  });

  it("is empty rather than throwing on a shape it does not recognise", () => {
    expect(parseTicketList(null)).toEqual([]);
    expect(parseTicketList("not json")).toEqual([]);
    expect(parseTicketList({ nothing: "here" })).toEqual([]);
  });
});

describe("parseSlaDetail", () => {
  it("reads the ticket a person checked by hand", () => {
    const record = parseSlaDetail(REF, DETAIL);
    expect(record.slaStatus).toBe("Within SLA");
    expect(record.slaPolicy).toBe("Commercial");
    expect(record.slaEndTime?.toISOString()).toBe("2026-08-31T12:30:00.000Z");
    expect(record.priority).toBe("WO Priority 7");
    expect(record.ticketKey).toBe("WO035640797");
    expect(record.caseId).toBe("5163861807");
  });

  it("keeps ft_sla as the status and ftSla as the policy", () => {
    // These two names differ by one underscore and mean completely different things. A
    // reader who assumes one is a typo for the other will swap them and nothing will crash.
    const record = parseSlaDetail(REF, { ft_sla: "SLA Breached", ftSla: "Consumer" });
    expect(record.slaStatus).toBe("SLA Breached");
    expect(record.slaPolicy).toBe("Consumer");
  });

  it("comes back empty for a ticket FieldEZ tracks no SLA on", () => {
    // WO-035655580's page showed a dash in every SLA field. Empty is the honest answer;
    // inventing a status for it would put it in a bucket it does not belong to.
    const record = parseSlaDetail(REF, { ft_sla: "-", ftSla: null, slaEndTime: null });
    expect(record.slaStatus).toBe("");
    expect(record.slaPolicy).toBe("");
    expect(record.slaEndTime).toBeNull();
  });

  it("survives a response that is not an object at all", () => {
    const record = parseSlaDetail(REF, "gateway timeout");
    expect(record.slaStatus).toBe("");
    expect(record.ticketNo).toBe("WO-035640797");
  });

  it("takes the work order and case id from the list, not the detail", () => {
    // Both responses carry them, under different names, and two sources for one fact is two
    // chances to disagree.
    const record = parseSlaDetail(REF, { ...DETAIL, ft_ticket_no: "WO-999999999" });
    expect(record.ticketNo).toBe("WO-035640797");
  });
});

describe("secondsRemaining and formatRemaining", () => {
  const now = new Date("2026-08-26T12:00:00.000Z");

  it("counts down from the stored deadline rather than from a copied countdown", () => {
    // The whole reason the deadline is stored and the countdown is not: this is correct
    // whenever it is asked, where a copied "121h 39m" would be stale within the minute.
    const end = new Date("2026-08-31T12:30:00.000Z");
    expect(secondsRemaining(end, now)).toBe(5 * 86400 + 1800);
  });

  it("goes negative once the promise has been missed", () => {
    expect(secondsRemaining(new Date("2026-08-25T12:00:00.000Z"), now)).toBe(-86400);
  });

  it("is null when there is no deadline", () => {
    expect(secondsRemaining(null, now)).toBeNull();
  });

  it("writes hours the way FieldEZ writes them", () => {
    expect(formatRemaining(438000)).toBe("121h 40m 0s");
    expect(formatRemaining(3661)).toBe("1h 1m 1s");
    expect(formatRemaining(0)).toBe("0h 0m 0s");
  });

  it("marks an overdue one rather than showing it as time in hand", () => {
    expect(formatRemaining(-3600)).toBe("-1h 0m 0s");
  });

  it("is empty when there is nothing to count", () => {
    expect(formatRemaining(null)).toBe("");
  });
});
