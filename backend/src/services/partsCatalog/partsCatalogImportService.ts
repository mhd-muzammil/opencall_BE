import xlsx from "xlsx";
import {
  replaceCatalogParts,
  type CatalogPartInput,
} from "../../repositories/partsCatalogRepository.js";

/**
 * Parses a Parts Catalog workbook and replaces the whole catalog. Mirrors the inventory
 * RMA import: headers are lower-cased with spaces → underscores, the part number lives in
 * a "Part" column (required), and rows without a part number are skipped.
 *
 * Recognised columns: part, part_description, category, price, hsn_code, igst, cgst, sgst,
 * eosl_flag, validity, parts_status.
 */

export interface PartsImportResult {
  totalRows: number;
  imported: number;
  skippedEmpty: number;
}

function cleanVal(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  let s = String(value).trim();
  // "12345.0" → "12345" (Excel numeric-as-text artefact)
  if (/\.0$/.test(s)) {
    const f = Number(s);
    if (Number.isFinite(f) && Number.isInteger(f)) s = String(f);
  }
  return s;
}

function parsePrice(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Excel date / serial / string → YYYY-MM-DD, or null. */
function parseValidity(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const p = xlsx.SSF.parse_date_code(value);
    if (!p) return null;
    return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  }
  const text = String(value).trim();
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(text);
  if (dmy) {
    return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

/** Reads a cell by header name after headers were normalised (lowercase, _). */
function get(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

export async function importPartsCatalogFromFile(
  filePath: string,
): Promise<PartsImportResult> {
  const workbook = xlsx.readFile(filePath, { cellDates: true, raw: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("No sheet found in the parts workbook");
  }
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    throw new Error("Parts worksheet is undefined");
  }

  // Normalise headers the same way the inventory importer does.
  const raw = xlsx.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: "",
  });
  const rows = raw.map((r) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(r)) {
      out[String(key).trim().toLowerCase().replace(/\s+/g, "_")] = r[key];
    }
    return out;
  });

  if (rows.length > 0 && !("part" in rows[0]!)) {
    throw new Error("Excel sheet must contain a 'Part' (part number) column.");
  }

  const inputs: CatalogPartInput[] = [];
  let skippedEmpty = 0;

  for (const row of rows) {
    const partNumber = cleanVal(get(row, "part"));
    if (!partNumber || partNumber.toLowerCase() === "nan") {
      skippedEmpty += 1;
      continue;
    }
    inputs.push({
      partNumber,
      description: cleanVal(get(row, "part_description")),
      category: cleanVal(get(row, "category")),
      price: parsePrice(get(row, "price")),
      hsnCode: cleanVal(get(row, "hsn_code")),
      igst: cleanVal(get(row, "igst")),
      cgst: cleanVal(get(row, "cgst")),
      sgst: cleanVal(get(row, "sgst")),
      eoslFlag: cleanVal(get(row, "eosl_flag")),
      validity: parseValidity(get(row, "validity")),
      partsStatus: cleanVal(get(row, "parts_status")),
    });
  }

  const imported = await replaceCatalogParts(inputs);
  return { totalRows: rows.length, imported, skippedEmpty };
}
