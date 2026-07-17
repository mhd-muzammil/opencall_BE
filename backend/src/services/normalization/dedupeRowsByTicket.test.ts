import { describe, expect, it } from "vitest";
import {
  buildOpenCallPartDisplay,
  dedupeRowsByTicket,
  filterReceivedParts,
  formatOpenCallPartCell,
  groupRowsByTicket,
  sumReceivedPartValues,
  type PartLine,
} from "./dedupeRowsByTicket.js";

interface PartRow {
  ticketId: string;
  rowNumber: number;
  goodPartNo?: string | null;
  partDescription?: string | null;
  partOrderNo?: string | null;
  soNumber?: string | null;
  goodPartInstalledStatus?: string | null;
  partShipmentStatus?: string | null;
  flexStatus?: string | null;
  engineer?: string | null;
  price?: number | null;
}

describe("dedupeRowsByTicket", () => {
  it("dedupes by normalized ticket key and counts removed duplicates", () => {
    const result = dedupeRowsByTicket([
      {
        ticketId: "WO-000123",
        rowNumber: 2,
        flexStatus: "OPEN",
      },
      {
        ticketId: "123",
        rowNumber: 1,
        flexStatus: "CLOSED",
        engineer: "Alex",
      },
      {
        ticketId: "WO-000124",
        rowNumber: 3,
        flexStatus: "OPEN",
      },
    ]);

    expect(result.duplicateCount).toBe(1);
    expect(result.dedupedRows).toHaveLength(2);
    expect(result.dedupedRows[0]?.ticketId).toBe("123");
    expect(result.dedupedRows[1]?.ticketId).toBe("WO-000124");
  });

  it("prefers the row with the most meaningful non-null fields", () => {
    const result = dedupeRowsByTicket([
      {
        ticketId: "WO-34004086",
        rowNumber: 1,
        flexStatus: "OPEN",
        engineer: null,
        location: "   ",
      },
      {
        ticketId: "wo34004086",
        rowNumber: 2,
        flexStatus: "OPEN",
        engineer: "Sam",
        location: "Delhi",
      },
    ]);

    expect(result.duplicateCount).toBe(1);
    expect(result.dedupedRows[0]).toMatchObject({
      rowNumber: 2,
      engineer: "Sam",
      location: "Delhi",
    });
  });

  it("prefers the latest timestamp when completeness ties", () => {
    const result = dedupeRowsByTicket([
      {
        ticketId: "WO-034067433",
        rowNumber: 5,
        flexStatus: "OPEN",
        partnerAccept: new Date("2026-05-04T08:00:00.000Z"),
      },
      {
        ticketId: "WO034067433",
        rowNumber: 9,
        flexStatus: "OPEN",
        partnerAccept: new Date("2026-05-04T10:00:00.000Z"),
      },
    ]);

    expect(result.dedupedRows[0]).toMatchObject({
      rowNumber: 9,
    });
  });

  it("falls back to the lowest row number when completeness and timestamp tie", () => {
    const result = dedupeRowsByTicket([
      {
        ticketId: "WO-900",
        rowNumber: 7,
        flexStatus: "OPEN",
      },
      {
        ticketId: "wo900",
        rowNumber: 3,
        flexStatus: "OPEN",
      },
    ]);

    expect(result.dedupedRows[0]).toMatchObject({
      rowNumber: 3,
    });
  });
});

describe("groupRowsByTicket", () => {
  it("groups a 3-part work order into one header/detail record, nothing dropped", () => {
    const { workOrders, duplicatePartLineCount } = groupRowsByTicket<PartRow>([
      {
        ticketId: "WO-032942124",
        rowNumber: 1,
        goodPartNo: "P-1",
        partOrderNo: "PO-1",
        partDescription: "SPS-MB UMA ADL-Q670 PON 440 G9 AIO",
        goodPartInstalledStatus: "RCV_SPARE",
      },
      {
        ticketId: "32942124",
        rowNumber: 2,
        goodPartNo: "P-2",
        partOrderNo: "PO-2",
        partDescription: "STRIP-ENCODER PLUS",
        goodPartInstalledStatus: "RCV_SPARE",
      },
      {
        ticketId: "WO032942124",
        rowNumber: 3,
        goodPartNo: "P-3",
        partOrderNo: "PO-3",
        partDescription: "ASSY-IDS_SYS",
        goodPartInstalledStatus: "RCV_SPARE",
      },
    ]);

    expect(workOrders).toHaveLength(1);
    expect(workOrders[0]?.ticketKey).toBe("32942124");
    expect(workOrders[0]?.parts).toHaveLength(3);
    expect(duplicatePartLineCount).toBe(0);
  });

  it("collapses a true duplicate part line and increments duplicatePartLineCount", () => {
    const { workOrders, duplicatePartLineCount } = groupRowsByTicket<PartRow>([
      {
        ticketId: "WO-100",
        rowNumber: 1,
        goodPartNo: "P-1",
        partOrderNo: "PO-1",
        partDescription: "PART ONE",
        goodPartInstalledStatus: "RCV_SPARE",
      },
      {
        ticketId: "WO-100",
        rowNumber: 2,
        goodPartNo: "P-1",
        partOrderNo: "PO-1",
        partDescription: "PART ONE",
        goodPartInstalledStatus: "RCV_SPARE",
      },
    ]);

    expect(workOrders).toHaveLength(1);
    expect(workOrders[0]?.parts).toHaveLength(1);
    expect(duplicatePartLineCount).toBe(1);
  });

  it("keeps the same good part under two different Part Order Nos as two parts", () => {
    const { workOrders, duplicatePartLineCount } = groupRowsByTicket<PartRow>([
      {
        ticketId: "WO-200",
        rowNumber: 1,
        goodPartNo: "P-1",
        partOrderNo: "PO-1",
        partDescription: "PART ONE",
        goodPartInstalledStatus: "RCV_SPARE",
      },
      {
        ticketId: "WO-200",
        rowNumber: 2,
        goodPartNo: "P-1",
        partOrderNo: "PO-2",
        partDescription: "PART ONE",
        goodPartInstalledStatus: "RCV_SPARE",
      },
    ]);

    expect(workOrders[0]?.parts).toHaveLength(2);
    expect(duplicatePartLineCount).toBe(0);
  });

  it("mixed work order: OpenCall lists ALL parts; inventory (received filter) still returns only the 2 RCV_SPARE", () => {
    const { workOrders } = groupRowsByTicket<PartRow>([
      {
        ticketId: "WO-300",
        rowNumber: 1,
        goodPartNo: "P-1",
        partOrderNo: "PO-1",
        partDescription: "RECEIVED ONE",
        goodPartInstalledStatus: "RCV_SPARE",
        price: 100,
      },
      {
        ticketId: "WO-300",
        rowNumber: 2,
        goodPartNo: "P-2",
        partOrderNo: "PO-2",
        partDescription: "RECEIVED TWO",
        goodPartInstalledStatus: "RCV_SPARE",
        price: 250,
      },
      {
        ticketId: "WO-300",
        rowNumber: 3,
        goodPartNo: "P-3",
        partOrderNo: "PO-3",
        partDescription: "IN TRANSIT ONE",
        goodPartInstalledStatus: "YTR_INTRANSIT",
        price: 999,
      },
    ]);

    const parts = workOrders[0]!.parts;
    const display = buildOpenCallPartDisplay(parts);

    // OpenCall now shows EVERY part (received + in-transit), source order, no hint.
    expect(display.text).toBe("RECEIVED ONE / RECEIVED TWO / IN TRANSIT ONE");
    expect(display.awaitingParts).toBe(false);
    expect(formatOpenCallPartCell(parts)).toBe(
      "RECEIVED ONE / RECEIVED TWO / IN TRANSIT ONE",
    );

    // Inventory: received-only stock — UNCHANGED by the display change.
    const inventoryParts = filterReceivedParts(parts);
    expect(inventoryParts).toHaveLength(2);
    expect(inventoryParts.map((p) => p.partDescription)).toEqual([
      "RECEIVED ONE",
      "RECEIVED TWO",
    ]);

    // Price / in-stock value = sum over the received parts only (in-transit
    // part's 999 is excluded). Prices are carried as an extra part-level field.
    const priceByPart = [100, 250, 999];
    const pricedParts = parts.map((part, index) => ({
      ...part,
      price: priceByPart[index]!,
    }));
    const price = sumReceivedPartValues(
      pricedParts,
      (part) => (part as PartLine & { price?: number | null }).price ?? null,
    );
    expect(price).toBe(350);
  });

  it("OpenCall keeps both identical descriptions (same good part, two Part Order Nos); received filter stays independent", () => {
    const { workOrders } = groupRowsByTicket<PartRow>([
      {
        ticketId: "WO-800",
        rowNumber: 1,
        goodPartNo: "P-1",
        partOrderNo: "PO-1",
        partDescription: "SAME DESC",
        goodPartInstalledStatus: "RCV_SPARE",
      },
      {
        ticketId: "WO-800",
        rowNumber: 2,
        goodPartNo: "P-1",
        partOrderNo: "PO-2",
        partDescription: "SAME DESC",
        goodPartInstalledStatus: "YTR_INTRANSIT",
      },
    ]);
    const parts = workOrders[0]!.parts;

    // Both distinct part lines are shown — not de-duped by description string.
    expect(formatOpenCallPartCell(parts)).toBe("SAME DESC / SAME DESC");

    // Received filter unaffected: only the RCV_SPARE line (PO-1) is stock.
    const received = filterReceivedParts(parts);
    expect(received).toHaveLength(1);
    expect(received[0]?.partOrderNo).toBe("PO-1");
  });

  it("all-in-transit work order: OpenCall lists the in-transit descriptions (not 'Awaiting parts'); still absent from inventory", () => {
    const { workOrders } = groupRowsByTicket<PartRow>([
      {
        ticketId: "WO-400",
        rowNumber: 1,
        goodPartNo: "P-1",
        partOrderNo: "PO-1",
        partDescription: "IN TRANSIT ONE",
        goodPartInstalledStatus: "YTR_INTRANSIT",
      },
      {
        ticketId: "WO-400",
        rowNumber: 2,
        goodPartNo: "P-2",
        partOrderNo: "PO-2",
        partDescription: "IN TRANSIT TWO",
        goodPartInstalledStatus: "YTR_INTRANSIT",
      },
    ]);

    const parts = workOrders[0]!.parts;

    // OpenCall: lists the in-transit part descriptions (the WO HAS parts, so it
    // is not "Awaiting parts").
    expect(workOrders).toHaveLength(1);
    expect(buildOpenCallPartDisplay(parts).awaitingParts).toBe(false);
    expect(formatOpenCallPartCell(parts)).toBe("IN TRANSIT ONE / IN TRANSIT TWO");

    // Inventory: omitted entirely (no received stock) — UNCHANGED.
    expect(filterReceivedParts(parts)).toHaveLength(0);
  });

  it("never counts a blank-installed-status service call as stock but still lists the work order", () => {
    const { workOrders } = groupRowsByTicket<PartRow>([
      {
        ticketId: "WO-500",
        rowNumber: 1,
        flexStatus: "OPEN",
        engineer: "Alex",
        // No good part / part order / description → no part line at all.
      },
    ]);

    expect(workOrders).toHaveLength(1);
    expect(workOrders[0]?.parts).toHaveLength(0);
    expect(filterReceivedParts(workOrders[0]!.parts)).toHaveLength(0);
    // Zero parts on the WO → "Awaiting parts" now means literally no parts.
    expect(buildOpenCallPartDisplay(workOrders[0]!.parts).awaitingParts).toBe(true);
    expect(formatOpenCallPartCell(workOrders[0]!.parts)).toBe("Awaiting parts");
  });

  it("chooses the header from the same row the dedupe ranking would win", () => {
    const rows: PartRow[] = [
      {
        ticketId: "WO-600",
        rowNumber: 1,
        flexStatus: "OPEN",
        engineer: null,
        goodPartNo: "P-1",
        partOrderNo: "PO-1",
        partDescription: "PART ONE",
        goodPartInstalledStatus: "RCV_SPARE",
      },
      {
        ticketId: "WO-600",
        rowNumber: 2,
        flexStatus: "OPEN",
        engineer: "Sam",
        goodPartNo: "P-2",
        partOrderNo: "PO-2",
        partDescription: "PART TWO",
        goodPartInstalledStatus: "RCV_SPARE",
      },
    ];

    const grouped = groupRowsByTicket<PartRow>(rows);
    const deduped = dedupeRowsByTicket<PartRow>(rows);

    expect(grouped.workOrders[0]?.header).toBe(deduped.dedupedRows[0]);
    expect(grouped.workOrders[0]?.header.rowNumber).toBe(2);
  });

  it("reads part fields from the raw Excel row when camel/snake props are absent", () => {
    const { workOrders } = groupRowsByTicket([
      {
        ticketId: "WO-700",
        rowNumber: 1,
        rawRow: {
          "Good Part No": "RAW-1",
          "Part Order No": "RPO-1",
          "Part Description": "RAW PART",
          "Good Part Installed Status": "RCV_SPARE",
          "Part Shipment Status(EEG)": "POD",
        },
      },
    ]);

    expect(workOrders[0]?.parts[0]).toMatchObject({
      goodPartNo: "RAW-1",
      partOrderNo: "RPO-1",
      partDescription: "RAW PART",
      goodPartInstalledStatus: "RCV_SPARE",
      partShipmentStatus: "POD",
    });
  });
});
