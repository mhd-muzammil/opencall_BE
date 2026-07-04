import { cleanString, normalizePincode } from "../normalization/valueNormalizer.js";

export type Segment =
  | "PC"
  | "Print"
  | "Install"
  | "Trade PC"
  | "Trade Print"
  | "";

export type LookupSource = ReadonlyMap<string, string> | Record<string, string>;

function isReadonlyMap<TValue>(
  lookup: ReadonlyMap<string, TValue> | Record<string, TValue>,
): lookup is ReadonlyMap<string, TValue> {
  return typeof (lookup as ReadonlyMap<string, TValue>).get === "function";
}

/** Uppercased, collapsed WO OTC code (e.g. "05F - Comp Field Install" -> "05F-COMP FIELD INSTALL"). */
function normalizeWoOtcCode(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ");
}

/** "01 - Trade" family: non-warranty billable work. */
function isTradeWoOtcCode(code: string): boolean {
  return code.includes("TRADE") || code.startsWith("01");
}

/** "05F - Comp Field Install": component field installation. */
function isCompFieldInstallWoOtcCode(code: string): boolean {
  return /^05F/.test(code);
}

/**
 * Derives the case segment from the FieldEZ (Flex WIP) report alone, using
 * the "Business Segment" (Computing / Printing) and "WO OTC Code" columns:
 *
 *   Computing      + 01-Trade / 05F Comp Field Install  -> "Trade PC"
 *   Computing      + any other OTC code                 -> "PC"
 *   Printing/dMPS  + 01-Trade                           -> "Trade Print"
 *   Printing/dMPS  + 05F Comp Field Install             -> "Install"
 *   Printing/dMPS  + any other OTC code                 -> "Print"
 *   (unknown business segment)                          -> ""
 */
export function getSegment(
  businessSegment: string | null | undefined,
  woOtcCode: string | null | undefined,
): Segment {
  const normalizedSegment = cleanString(businessSegment)?.toUpperCase() ?? "";
  const code = normalizeWoOtcCode(woOtcCode);
  const isTrade = isTradeWoOtcCode(code);
  const isCompFieldInstall = isCompFieldInstallWoOtcCode(code);

  const isComputing = normalizedSegment.includes("COMPUT") || normalizedSegment === "PC";
  // "Printing", "dMPS" (Managed Print Services) and bare "MPS" are all print-side.
  const isPrinting = normalizedSegment.includes("PRINT") || normalizedSegment.includes("MPS");

  if (isComputing) {
    return isTrade || isCompFieldInstall ? "Trade PC" : "PC";
  }

  if (isPrinting) {
    if (isTrade) {
      return "Trade Print";
    }
    return isCompFieldInstall ? "Install" : "Print";
  }

  return "";
}

export function calculateTAT(
  partnerAccept: Date | string | null | undefined,
  slaHours: number | null | undefined,
): string | null {
  if (!partnerAccept || slaHours === null || slaHours === undefined) {
    return null;
  }

  const start =
    partnerAccept instanceof Date ? partnerAccept : new Date(partnerAccept);

  if (Number.isNaN(start.getTime())) {
    return null;
  }

  return new Date(start.getTime() + slaHours * 60 * 60 * 1000).toISOString();
}

export function mapLocation(
  pincode: string | null | undefined,
  areaNameByPincode?: LookupSource,
): string | null {
  const normalizedPincode = normalizePincode(pincode);

  if (!normalizedPincode) {
    return null;
  }

  if (!areaNameByPincode) {
    return normalizedPincode;
  }

  if (isReadonlyMap(areaNameByPincode)) {
    return areaNameByPincode.get(normalizedPincode) ?? normalizedPincode;
  }

  const areaByPincodeRecord = areaNameByPincode;
  return areaByPincodeRecord[normalizedPincode] ?? normalizedPincode;
}

export function getLookupNumber(
  lookup: ReadonlyMap<string, number> | Record<string, number> | undefined,
  key: string | null | undefined,
): number | null {
  const normalizedKey = cleanString(key);

  if (!lookup || !normalizedKey) {
    return null;
  }

  if (isReadonlyMap(lookup)) {
    return lookup.get(normalizedKey) ?? lookup.get(normalizedKey.toUpperCase()) ?? null;
  }

  const lookupRecord = lookup;
  return lookupRecord[normalizedKey] ?? lookupRecord[normalizedKey.toUpperCase()] ?? null;
}
