import { describe, expect, it } from "vitest";
import { normalizeIndianPhone, parseAcerCallsText } from "./acerCallParser.js";

// Lines as the office pasted them on 18 Nov 2026 (tabs turned into runs of spaces).
const SPACED = `new calls

1877563C    33030206501 KANCHEEPURAM PUMS KUNNAVAKKAM HITECH L    Awaiting Onsite Visit    On-Site    Veriton M4670G    DT COMMERCIAL    UD33LSI0034390C9B20700    CANT POWER ON SYSTEM    In Warranty    33030206501 KANCHEEPURAM PUMS KUNNAVAKKAM HITECH LAB 631604 9444810595 9894960344    631604        91-9444810595

1883477C    33030102801 KANCHEEPURAM PUMS, KALAKATTUR HITECH L    Awaiting Onsite Visit    On-Site    Veriton M4670G    DT COMMERCIAL    UD33LSI003441067F80700    CANT POWER ON SYSTEM    In Warranty    33030102801 KANCHEEPURAM PUMS, KALAKATTUR HITECH LAB 631502 Lakshmi N 9789459434    631502        91-9789459434
`;

const TABBED = [
  "Case ID\tCustomer Name\tCall Status\tService Type\tModel\tProduct Category\tSerial Number\tIssue Description\tWarranty Status\tFull Address\tPincode\tAlt Contact\tPrimary Contact",
  "1883469C\t33030204901 KANCHEEPURAM PUMS SAMANTHIPURAM HITECH\tAwaiting Onsite Visit\tOn-Site\tEV226HQL\tMONITOR PROFESSIONAL\tZLM01SI00243401C299F00\tCANT POWER ON SYSTEM\tIn Warranty\t33030204901 KANCHEEPURAM PUMS SAMANTHIPURAM HITECH LAB 631552 9159791006 9444607627\t631552\t\t91-9159791006",
].join("\n");

describe("parseAcerCallsText", () => {
  it("reads space-separated lines and skips the heading", () => {
    const result = parseAcerCallsText(SPACED);

    expect(result.ignoredLines).toEqual([{ lineNumber: 1, text: "new calls" }]);
    expect(result.calls).toHaveLength(2);

    const [first, second] = result.calls;
    expect(first).toMatchObject({
      lineNumber: 3,
      caseId: "1877563C",
      customerName: "33030206501 KANCHEEPURAM PUMS KUNNAVAKKAM HITECH L",
      callStatus: "Awaiting Onsite Visit",
      serviceType: "On-Site",
      model: "Veriton M4670G",
      productCategory: "DT COMMERCIAL",
      serialNumber: "UD33LSI0034390C9B20700",
      issueDescription: "CANT POWER ON SYSTEM",
      warrantyStatus: "In Warranty",
      fullAddress:
        "33030206501 KANCHEEPURAM PUMS KUNNAVAKKAM HITECH LAB 631604 9444810595 9894960344",
      pincode: "631604",
      primaryContact: "9444810595",
      altContact: "9894960344",
      errors: [],
      warnings: [],
    });
    // Only one number in the address, and it is the primary: no alt contact.
    expect(second).toMatchObject({ caseId: "1883477C", pincode: "631502", primaryContact: "9789459434", altContact: "" });
  });

  it("reads tab-separated lines with an empty Alt Contact column and a header row", () => {
    const result = parseAcerCallsText(TABBED);

    expect(result.ignoredLines.map((line) => line.lineNumber)).toEqual([1]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({
      caseId: "1883469C",
      model: "EV226HQL",
      productCategory: "MONITOR PROFESSIONAL",
      pincode: "631552",
      primaryContact: "9159791006",
      altContact: "9444607627",
      errors: [],
    });
  });

  it("keeps a call whole when Excel quotes a cell with a line break in it", () => {
    const paste = [
      "1900004C\tPUMS ARCOT HITECH LAB\tAwaiting Onsite Visit\tOn-Site\tVeriton M4670G\tDT COMMERCIAL\tUD33X\tNO POWER\tIn Warranty\t\"PUMS ARCOT\nHITECH LAB \"\"B\"\" BLOCK 632503\"\t632503\t\t91-9123456780",
      "1900005C\tGOVT HSS CHENNAI\tAwaiting Onsite Visit\tOn-Site\tEV226HQL\tMONITOR PROFESSIONAL\tZLM01\tNO DISPLAY\tIn Warranty\tANNA NAGAR 600040\t600040\t\t91-9876543210",
    ].join("\n");
    const result = parseAcerCallsText(paste);

    expect(result.ignoredLines).toEqual([]);
    expect(result.calls.map((call) => [call.lineNumber, call.caseId])).toEqual([
      [1, "1900004C"],
      [3, "1900005C"],
    ]);
    expect(result.calls[0]).toMatchObject({
      fullAddress: 'PUMS ARCOT HITECH LAB "B" BLOCK 632503',
      pincode: "632503",
      primaryContact: "9123456780",
    });
  });

  // Acer's shorter view (production, 19 Nov 2026): no Call Status / Service Type columns.
  const SHORT_CELLS = [
    "1893265C",
    "33030304603 KANCHEEPURAM PUMS MALAYANKULAM HITECH",
    "Veriton M4670G",
    "DT COMMERCIAL",
    "UD33LSI0034300D8670700",
    "CANT POWER ON SYSTEM",
    "In Warranty",
    "33030304603 KANCHEEPURAM PUMS MALAYANKULAM HITECH LAB 631603 9952531056 9787475577",
    "631603",
    "",
    "91-9952531056",
  ];
  const SHORT_EXPECTED = {
    caseId: "1893265C",
    customerName: "33030304603 KANCHEEPURAM PUMS MALAYANKULAM HITECH",
    callStatus: "",
    serviceType: "",
    model: "Veriton M4670G",
    productCategory: "DT COMMERCIAL",
    serialNumber: "UD33LSI0034300D8670700",
    issueDescription: "CANT POWER ON SYSTEM",
    warrantyStatus: "In Warranty",
    fullAddress: "33030304603 KANCHEEPURAM PUMS MALAYANKULAM HITECH LAB 631603 9952531056 9787475577",
    pincode: "631603",
    primaryContact: "9952531056",
    altContact: "9787475577",
    errors: [],
    warnings: [],
  };

  it("reads Acer's shorter view (no Call Status / Service Type) by content — tabs", () => {
    const result = parseAcerCallsText(SHORT_CELLS.join("\t"));
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject(SHORT_EXPECTED);
  });

  it("reads Acer's shorter view by content — spaces", () => {
    const result = parseAcerCallsText(SHORT_CELLS.filter(Boolean).join("    "));
    expect(result.calls[0]).toMatchObject(SHORT_EXPECTED);
  });

  it("reads a view with only one of Call Status / Service Type", () => {
    const cells = [...SHORT_CELLS];
    cells.splice(2, 0, "On-Site");
    const result = parseAcerCallsText(cells.join("\t"));
    expect(result.calls[0]).toMatchObject({ ...SHORT_EXPECTED, serviceType: "On-Site" });
  });

  it("follows a pasted header row whatever its column order", () => {
    const header = ["Case ID", "Customer Name", "Pincode", "Model", "Serial Number", "Warranty Status", "Primary Contact", "Full Address"];
    const line = ["1893266C", "GOVT HSS", "600040", "EV226HQL", "ZLM01SI00243401C299F00", "In Warranty", "91-9876543210", "ANNA NAGAR"];
    const result = parseAcerCallsText(`${header.join("\t")}\n${line.join("\t")}`);
    expect(result.calls[0]).toMatchObject({
      caseId: "1893266C",
      customerName: "GOVT HSS",
      pincode: "600040",
      model: "EV226HQL",
      serialNumber: "ZLM01SI00243401C299F00",
      warrantyStatus: "In Warranty",
      primaryContact: "9876543210",
      fullAddress: "ANNA NAGAR",
    });
  });

  it("warns when a line cannot be placed by content", () => {
    const cells = ["1893267C", "SOME SCHOOL", "a", "b", "c", "d", "e", "f", "g", "ADDRESS", "123", "", "91-9876543210"];
    const result = parseAcerCallsText(cells.join("\t"));
    expect(result.calls[0]?.warnings.join(" ")).toMatch(/Could not recognise/);
    expect(result.calls[0]?.warnings.join(" ")).toMatch(/not a 6-digit pincode/);
  });

  it("flags the same case pasted twice", () => {
    const line = TABBED.split("\n")[1] ?? "";
    const result = parseAcerCallsText(`${line}\n${line}`);

    expect(result.calls[0]?.errors).toEqual([]);
    expect(result.calls[1]?.errors).toEqual(["Case 1883469C is already on line 1 of this paste."]);
  });
});

describe("normalizeIndianPhone", () => {
  it("drops the 91 country code and punctuation", () => {
    expect(normalizeIndianPhone("91-9444810595")).toBe("9444810595");
    expect(normalizeIndianPhone("+91 94448 10595")).toBe("9444810595");
    expect(normalizeIndianPhone("09444810595")).toBe("9444810595");
  });

  it("leaves a name alone", () => {
    expect(normalizeIndianPhone("Lakshmi N")).toBe("Lakshmi N");
    expect(normalizeIndianPhone("-")).toBe("");
  });
});
