/**
 * Reads Acer calls out of text a SUPER_ADMIN copies from Acer's portal.
 *
 * One call per line, 13 columns in this order (the portal's own order):
 *
 *   Case ID · Customer Name · Call Status · Service Type · Model · Product Category ·
 *   Serial Number · Issue Description · Warranty Status · Full Address · Pincode ·
 *   Alt Contact · Primary Contact
 *
 * Copied from the portal's table the columns are TAB separated, and an empty column
 * (Alt Contact usually is) is two tabs in a row. Pasted through chat or e-mail the tabs
 * often turn into runs of spaces and the empty column vanishes, so the parser does not
 * trust positions after Warranty Status: it finds the 6-digit Pincode and takes the
 * Full Address as everything between Warranty Status and it, and the contacts as what
 * follows it.
 *
 * Lines that are not calls ("new calls", a header row, blank lines) are skipped and
 * listed back so the admin can see nothing was lost.
 */

export interface ParsedAcerCall {
  /** 1-based line in the pasted text, so a problem can be pointed at. */
  lineNumber: number;
  caseId: string;
  customerName: string;
  callStatus: string;
  serviceType: string;
  model: string;
  productCategory: string;
  serialNumber: string;
  issueDescription: string;
  warrantyStatus: string;
  fullAddress: string;
  pincode: string;
  primaryContact: string;
  altContact: string;
  /** The line as pasted, kept with the call. */
  sourceLine: string;
  /** Problems that stop the call being saved. */
  errors: string[];
  /** Things worth a look that do not stop it. */
  warnings: string[];
}

export interface ParsedAcerPaste {
  calls: ParsedAcerCall[];
  /** Non-blank lines that were not calls, with their line numbers. */
  ignoredLines: { lineNumber: number; text: string }[];
}

/** The columns before Full Address, in the portal's full (13-column) order. */
const LEADING_FIELDS = [
  "caseId",
  "customerName",
  "callStatus",
  "serviceType",
  "model",
  "productCategory",
  "serialNumber",
  "issueDescription",
  "warrantyStatus",
] as const;

type CallField =
  | (typeof LEADING_FIELDS)[number]
  | "fullAddress"
  | "pincode"
  | "altContact"
  | "primaryContact";

/**
 * A call line has at least Case ID, Customer, Model, Category, Serial, Issue,
 * Warranty and an address or pincode. Acer's portal has more than one view: the
 * full one has Call Status and Service Type after the customer, a shorter one
 * (seen 19 Nov 2026) leaves both out — so columns are found by what they hold,
 * not by position.
 */
const MIN_CALL_COLUMNS = 8;

const PINCODE_RE = /^\d{6}$/;

const TAB = String.fromCharCode(9);

/** "In Warranty", "Out of Warranty", "OOW", "AMC", "Extended Warranty"… */
const WARRANTY_RE = /warrant|^\s*(iw|oow|ow|amc|ew|cmc)\s*$/i;

/** A product serial: one word of letters and digits, at least 10 long. */
const SERIAL_RE = /^(?=.*\d)(?=.*[a-z])[a-z0-9]{10,}$/i;

/** A Service Type value, to tell it from a Call Status when only one of them is there. */
const SERVICE_TYPE_RE = /on[\s-]?site|carry|pick[\s-]?up|walk[\s-]?in|depot|drop/i;

/** Header names (lower-cased, letters only) -> field. */
const HEADER_FIELDS: Record<string, CallField> = {
  caseid: "caseId",
  customername: "customerName",
  customer: "customerName",
  callstatus: "callStatus",
  status: "callStatus",
  servicetype: "serviceType",
  model: "model",
  productcategory: "productCategory",
  category: "productCategory",
  serialnumber: "serialNumber",
  serialno: "serialNumber",
  serial: "serialNumber",
  issuedescription: "issueDescription",
  issue: "issueDescription",
  problemdescription: "issueDescription",
  warrantystatus: "warrantyStatus",
  warranty: "warrantyStatus",
  fulladdress: "fullAddress",
  address: "fullAddress",
  pincode: "pincode",
  pin: "pincode",
  altcontact: "altContact",
  alternatecontact: "altContact",
  primarycontact: "primaryContact",
  contact: "primaryContact",
  mobile: "primaryContact",
};

/** A header row's columns as fields, or null when it names no Case ID column. */
function headerMapFor(cells: readonly string[]): (CallField | null)[] | null {
  const map = cells.map((cell) => HEADER_FIELDS[cell.toLowerCase().replace(/[^a-z]/g, "")] ?? null);
  return map[0] === "caseId" ? map : null;
}

function splitColumns(line: string): string[] {
  const cells = line.includes("\t") ? line.split("\t") : line.split(/ {2,}/);
  const trimmed = cells.map((cell) => cell.trim().replace(/\s+/g, " "));
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") {
    trimmed.pop();
  }
  return trimmed;
}

/**
 * A phone number as the engineer dials it: digits only, without the 91 country code
 * the portal prefixes ("91-9444810595" -> "9444810595"). Text that is not a number
 * (a name typed in the column) is returned trimmed, unchanged.
 */
export function normalizeIndianPhone(value: string): string {
  const text = value.trim();
  const digits = text.replace(/\D/g, "");
  if (digits.length < 8 || /[a-z]/i.test(text)) {
    return text === "-" ? "" : text;
  }
  if (digits.length === 12 && digits.startsWith("91")) {
    return digits.slice(2);
  }
  if (digits.length === 11 && digits.startsWith("0")) {
    return digits.slice(1);
  }
  return digits;
}

/** Ten-digit mobile numbers written into a free-text address. */
function mobileNumbersIn(text: string): string[] {
  return [...text.matchAll(/(?<!\d)[6-9]\d{9}(?!\d)/g)].map((match) => match[0]);
}

function isHeaderRow(cells: readonly string[]): boolean {
  return /^case\s*id$/i.test(cells[0] ?? "");
}

/**
 * Places the cells before the address — Call Status / Service Type (when the view has
 * them), Model, Category, Serial, Issue, Warranty — by content: the Serial is the long
 * letters-and-digits word, Model and Category are the two cells before it, the Warranty
 * cell says "warranty", and the Issue is what lies between them. Returns the index of
 * the first cell after Warranty, or -1 when the line does not look like that (then the
 * caller falls back to the full view's fixed positions and warns).
 */
function placeLeadingByContent(cells: readonly string[], call: ParsedAcerCall): number {
  let warrantyIndex = -1;
  for (let index = 2; index < cells.length; index += 1) {
    if (WARRANTY_RE.test(cells[index] ?? "")) {
      warrantyIndex = index;
      break;
    }
  }
  if (warrantyIndex < 0) return -1;

  let serialIndex = -1;
  for (let index = warrantyIndex - 1; index >= 4; index -= 1) {
    if (SERIAL_RE.test(cells[index] ?? "")) {
      serialIndex = index;
      break;
    }
  }
  if (serialIndex < 0) return -1;

  const statusCells = cells.slice(2, serialIndex - 2);
  if (statusCells.length > 2) return -1;
  if (statusCells.length === 2) {
    call.callStatus = statusCells[0] ?? "";
    call.serviceType = statusCells[1] ?? "";
  } else if (statusCells.length === 1) {
    const only = statusCells[0] ?? "";
    if (SERVICE_TYPE_RE.test(only)) call.serviceType = only;
    else call.callStatus = only;
  }
  call.model = cells[serialIndex - 2] ?? "";
  call.productCategory = cells[serialIndex - 1] ?? "";
  call.serialNumber = cells[serialIndex] ?? "";
  call.issueDescription = cells.slice(serialIndex + 1, warrantyIndex).filter(Boolean).join(" ");
  call.warrantyStatus = cells[warrantyIndex] ?? "";
  return warrantyIndex + 1;
}

function parseCallLine(
  cells: readonly string[],
  lineNumber: number,
  sourceLine: string,
  headerMap: readonly (CallField | null)[] | null = null,
): ParsedAcerCall {
  const call: ParsedAcerCall = {
    lineNumber,
    caseId: "",
    customerName: "",
    callStatus: "",
    serviceType: "",
    model: "",
    productCategory: "",
    serialNumber: "",
    issueDescription: "",
    warrantyStatus: "",
    fullAddress: "",
    pincode: "",
    primaryContact: "",
    altContact: "",
    sourceLine,
    errors: [],
    warnings: [],
  };

  call.caseId = (cells[0] ?? "").toUpperCase();
  call.customerName = cells[1] ?? "";

  // A pasted header row names every column: the surest way to read the lines under it.
  if (headerMap) {
    headerMap.forEach((field, index) => {
      if (!field || field === "caseId") return;
      const value = cells[index] ?? "";
      if (field === "fullAddress") {
        call.fullAddress = [call.fullAddress, value].filter(Boolean).join(", ");
      } else if (field === "primaryContact" || field === "altContact") {
        call[field] = normalizeIndianPhone(value);
      } else {
        call[field] = value;
      }
    });
    finishCall(call);
    return call;
  }

  let restStart = placeLeadingByContent(cells, call);
  if (restStart < 0) {
    // Not recognisable by content: read the full view's fixed positions, and say so.
    LEADING_FIELDS.forEach((field, index) => {
      if (index >= 2) call[field] = cells[index] ?? "";
    });
    restStart = LEADING_FIELDS.length;
    call.warnings.push(
      "Could not recognise the Serial Number / Warranty columns — check every field before saving.",
    );
  }

  const rest = cells.slice(restStart);
  // The Pincode column: the LAST 6-digit cell (an address can hold a pincode too,
  // but never as a whole column of its own after the pincode column).
  let pincodeIndex = -1;
  for (let index = rest.length - 1; index >= 1; index -= 1) {
    if (PINCODE_RE.test(rest[index] ?? "")) {
      pincodeIndex = index;
      break;
    }
  }

  let contacts: string[];
  if (pincodeIndex >= 1) {
    call.fullAddress = rest.slice(0, pincodeIndex).filter(Boolean).join(", ");
    call.pincode = rest[pincodeIndex] ?? "";
    contacts = rest.slice(pincodeIndex + 1);
  } else {
    // No pincode column: fall back to the portal's positions.
    call.fullAddress = rest[0] ?? "";
    call.pincode = rest[1] ?? "";
    contacts = rest.slice(2);
    call.warnings.push("No 6-digit pincode found — check the Pincode column.");
  }

  // After the pincode: [Alt Contact, Primary Contact], or just [Primary Contact]
  // when the empty Alt Contact column was lost on the way.
  const nonEmptyContacts = contacts.filter((cell) => cell !== "");
  if (contacts.length >= 2) {
    call.altContact = normalizeIndianPhone(contacts.slice(0, -1).filter(Boolean).join(" "));
    call.primaryContact = normalizeIndianPhone(contacts[contacts.length - 1] ?? "");
  } else if (nonEmptyContacts.length === 1) {
    call.primaryContact = normalizeIndianPhone(nonEmptyContacts[0] ?? "");
  }

  finishCall(call);
  return call;
}

/** Fills Alt Contact from the address, and checks every field is the kind it should be. */
function finishCall(call: ParsedAcerCall): void {
  // The portal usually leaves Alt Contact blank but writes both numbers at the end
  // of the address. Take the one that is not the primary.
  if (!call.altContact) {
    const other = mobileNumbersIn(call.fullAddress).find(
      (number) => number !== call.primaryContact,
    );
    if (other) {
      call.altContact = other;
    }
  }

  if (!call.caseId) {
    call.errors.push("Case ID is missing.");
  } else if (/\s/.test(call.caseId)) {
    call.errors.push(`Case ID "${call.caseId}" has a space in it — the columns may be out of line.`);
  }
  if (!call.customerName) {
    call.errors.push("Customer Name is missing.");
  }
  if (!call.primaryContact) {
    call.warnings.push("No primary contact number.");
  } else if (!/^[6-9]\d{9}$/.test(call.primaryContact)) {
    call.warnings.push(`Primary Contact "${call.primaryContact}" is not a 10-digit mobile number.`);
  }
  if (!call.serialNumber) {
    call.warnings.push("No serial number.");
  }
  // The checks that catch a line read into the wrong columns.
  if (call.pincode && !PINCODE_RE.test(call.pincode)) {
    call.warnings.push(`Pincode "${call.pincode}" is not a 6-digit pincode — the columns may be out of line.`);
  }
  if (call.warrantyStatus && !WARRANTY_RE.test(call.warrantyStatus)) {
    call.warnings.push(`Warranty Status "${call.warrantyStatus}" does not look like a warranty — the columns may be out of line.`);
  }
  if (SERIAL_RE.test(call.model) && !SERIAL_RE.test(call.serialNumber)) {
    call.warnings.push("Model looks like a serial number — the columns may be out of line.");
  }
}

/**
 * The pasted text as logical lines, each with the line number it starts on.
 *
 * Excel copies a cell that holds a line break (an address typed over two lines) in
 * double quotes, with the break inside — so one call spans two physical lines. In a
 * tab-separated paste a cell that starts with a quote is read up to its closing
 * quote ("" is a literal quote) and its line breaks become spaces. A paste with no
 * tabs is read line by line, as typed.
 */
function logicalLines(text: string): { lineNumber: number; text: string }[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.includes("\t")) {
    return normalized.split("\n").map((line, index) => ({ lineNumber: index + 1, text: line }));
  }
  const lines: { lineNumber: number; text: string }[] = [];
  let physical = 1;
  let start = 1;
  let current = "";
  let cellStart = true;
  let quoted = false;
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else if (ch === "\n") {
        physical += 1;
        current += " ";
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' && cellStart) {
      quoted = true;
      cellStart = false;
      continue;
    }
    if (ch === "\n") {
      lines.push({ lineNumber: start, text: current });
      physical += 1;
      start = physical;
      current = "";
      cellStart = true;
      continue;
    }
    current += ch;
    cellStart = ch === "\t";
  }
  lines.push({ lineNumber: start, text: current });
  return lines;
}

export function parseAcerCallsText(text: string): ParsedAcerPaste {
  const calls: ParsedAcerCall[] = [];
  const ignoredLines: ParsedAcerPaste["ignoredLines"] = [];

  // A header row, when one is pasted, decides the columns of the lines under it.
  let headerMap: (CallField | null)[] | null = null;
  logicalLines(text).forEach(({ lineNumber, text: rawLine }) => {
    if (!rawLine.trim()) {
      return;
    }
    const cells = splitColumns(rawLine);
    if (isHeaderRow(cells)) {
      headerMap = headerMapFor(cells);
      ignoredLines.push({ lineNumber, text: rawLine.trim() });
      return;
    }
    if (cells.length < MIN_CALL_COLUMNS) {
      ignoredLines.push({ lineNumber, text: rawLine.trim() });
      return;
    }
    // Only a tab-separated line keeps its empty cells, so only it lines up with a header.
    const lineHeader = rawLine.includes(TAB) ? headerMap : null;
    calls.push(parseCallLine(cells, lineNumber, rawLine.trim(), lineHeader));
  });

  // The same case pasted twice in one go.
  const seen = new Map<string, number>();
  for (const call of calls) {
    if (!call.caseId) continue;
    const first = seen.get(call.caseId);
    if (first !== undefined) {
      call.errors.push(`Case ${call.caseId} is already on line ${first} of this paste.`);
    } else {
      seen.set(call.caseId, call.lineNumber);
    }
  }

  return { calls, ignoredLines };
}
