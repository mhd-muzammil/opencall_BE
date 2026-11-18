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

/** The fixed columns before Full Address. */
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

/** A call line has at least the leading columns plus an address or pincode. */
const MIN_CALL_COLUMNS = LEADING_FIELDS.length + 1;

const PINCODE_RE = /^\d{6}$/;

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

function parseCallLine(cells: readonly string[], lineNumber: number, sourceLine: string): ParsedAcerCall {
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

  LEADING_FIELDS.forEach((field, index) => {
    call[field] = cells[index] ?? "";
  });
  call.caseId = call.caseId.toUpperCase();

  const rest = cells.slice(LEADING_FIELDS.length);
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
  }
  if (!call.serialNumber) {
    call.warnings.push("No serial number.");
  }

  return call;
}

export function parseAcerCallsText(text: string): ParsedAcerPaste {
  const calls: ParsedAcerCall[] = [];
  const ignoredLines: ParsedAcerPaste["ignoredLines"] = [];

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    if (!rawLine.trim()) {
      return;
    }
    const cells = splitColumns(rawLine);
    if (cells.length < MIN_CALL_COLUMNS || isHeaderRow(cells)) {
      ignoredLines.push({ lineNumber, text: rawLine.trim() });
      return;
    }
    calls.push(parseCallLine(cells, lineNumber, rawLine.trim()));
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
