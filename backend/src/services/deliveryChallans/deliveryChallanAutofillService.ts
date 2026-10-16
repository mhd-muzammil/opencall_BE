import { query } from "../../config/database.js";
import type { DeliveryChallanItem } from "../../repositories/deliveryChallanRepository.js";
import { extractPartLine } from "../normalization/dedupeRowsByTicket.js";
import { autofillQuotation } from "../quotations/quotationAutofillService.js";

/**
 * Auto-fill for a delivery challan, from a Case ID or WO (Ticket) number.
 *
 * Customer and product come from exactly the lookup the quotation form uses
 * (autofillQuotation: the most recent Flex WIP record for the case). The goods rows are
 * the case's parts, read the way fetchCaseParts reads them for inventory, with the HSN
 * code taken from the Parts Catalog when the part number matches exactly. Everything is a
 * best-effort prefill the form can change before saving. Null when no case matches.
 */

export interface DeliveryChallanAutofill {
  caseId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  /** One block: address, city, state and pincode, one per line, blanks left out. */
  customerAddress: string;
  productSerial: string;
  productNumber: string;
  productName: string;
  items: DeliveryChallanItem[];
}

/** What a challan needs from one part line. */
interface CasePartLine {
  description: string;
  goodPartNo: string;
}

/**
 * Every distinct part ordered against a case, from the LATEST Flex batch that carries it
 * (older batches may list stale parts) — the same rule as fetchCaseParts in
 * inventorySyncService. Unlike that one it keeps the part's description, which is what
 * the challan prints, and it leaves out rows with no part at all (a service call with no
 * spare) instead of standing in a blank one. Source row order, so the sheet lists the
 * parts as Flex does.
 *
 * Deduped on the same identity as fetchCaseParts (Part Order No, else Good Part No), so a
 * part re-listed by a re-uploaded export appears once. Best-effort like fetchCaseParts: a
 * failed lookup leaves the goods table empty rather than failing the whole auto-fill.
 */
async function fetchCasePartLines(caseId: string): Promise<CasePartLine[]> {
  try {
    const result = await query<{ raw_row: Record<string, unknown> }>(
      `
        WITH latest AS (
          SELECT fw.upload_batch_id AS id
          FROM flex_wip_records fw
          JOIN source_upload_batches b ON b.id = fw.upload_batch_id
          WHERE fw.case_id = $1 OR fw.normalized_case_id = $1
          ORDER BY b.created_at DESC
          LIMIT 1
        )
        SELECT fw.raw_row
        FROM flex_wip_records fw
        WHERE fw.upload_batch_id IN (SELECT id FROM latest)
          AND (fw.case_id = $1 OR fw.normalized_case_id = $1)
        ORDER BY fw.row_number
      `,
      [caseId],
    );

    const seen = new Set<string>();
    const lines: CasePartLine[] = [];
    for (const row of result.rows) {
      // extractPartLine handles the column-name variants ("Good Part No" vs
      // "Good Part Number", ...) the same way the report generator does.
      const part = extractPartLine({ rawRow: row.raw_row });
      const description = part.partDescription ?? "";
      const goodPartNo = part.goodPartNo ?? "";
      if (!description && !goodPartNo) continue;

      const identity = (part.partOrderNo || goodPartNo || `description:${description}`)
        .trim()
        .toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      lines.push({ description, goodPartNo });
    }
    return lines;
  } catch (error) {
    console.error("[DeliveryChallanAutofill] parts lookup failed:", error);
    return [];
  }
}

/**
 * HSN codes from the Parts Catalog, keyed by part number. Exact match only: a near miss
 * would print another part's tax code on the sheet, and a blank is the honest answer.
 */
async function hsnCodesFor(partNumbers: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(partNumbers.filter((partNumber) => partNumber !== ""))];
  const found = new Map<string, string>();
  if (wanted.length === 0) return found;

  try {
    const result = await query<{ part_number: string; hsn_code: string }>(
      `SELECT part_number, hsn_code
         FROM parts_catalog
        WHERE part_number = ANY($1::text[])
          AND hsn_code <> ''
        ORDER BY part_number`,
      [wanted],
    );
    for (const row of result.rows) {
      const hsn = row.hsn_code.trim();
      if (hsn && !found.has(row.part_number)) {
        found.set(row.part_number, hsn);
      }
    }
  } catch (error) {
    console.error("[DeliveryChallanAutofill] HSN lookup failed:", error);
  }
  return found;
}

export async function autofillDeliveryChallan(input: {
  caseId?: string;
  orderNumber?: string;
}): Promise<DeliveryChallanAutofill | null> {
  const found = await autofillQuotation(input);
  if (!found) {
    return null;
  }

  // The case id the record names, so a lookup by WO number still finds the case's parts.
  const parts = found.caseId ? await fetchCasePartLines(found.caseId) : [];
  const hsnByPart = await hsnCodesFor(parts.map((part) => part.goodPartNo));

  return {
    caseId: found.caseId,
    orderNumber: found.orderNumber,
    customerName: found.customerName,
    customerPhone: found.customerPhone,
    customerEmail: found.customerEmail,
    // The quotation sheet prints these as four lines; the challan has one address block.
    customerAddress: [
      found.customerAddress,
      found.customerCity,
      found.customerState,
      found.customerPincode,
    ]
      .filter((line) => line !== "")
      .join("\n"),
    productSerial: found.serialNo,
    productNumber: found.modelNo,
    productName: found.productDescription,
    items: parts.map((part) => ({
      description: part.description,
      hsnSac: (part.goodPartNo && hsnByPart.get(part.goodPartNo)) || "",
      qty: "01",
      rate: "",
      per: "",
    })),
  };
}
