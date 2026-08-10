import { describe, expect, it } from "vitest";
import {
  hasUsableCoordinate,
  parseCsv,
  readDirectoryCsv,
  resolvePincodeCoordinates,
  type DirectoryOffice,
} from "./pincodeDirectory.js";

function office(partial: Partial<DirectoryOffice> & { pincode: string }): DirectoryOffice {
  return {
    officeName: "Test B.O",
    officeType: "BO",
    district: "CHENNAI",
    stateName: "TAMIL NADU",
    latitude: 13.05,
    longitude: 80.18,
    ...partial,
  };
}

/**
 * Enough offices around Chennai to give the 600-prefix a real anchor. Without a
 * populated prefix the gate has nothing to measure against.
 */
function chennaiBackground(): DirectoryOffice[] {
  return Array.from({ length: 40 }, (_, i) =>
    office({
      pincode: `600${String(200 + i).padStart(3, "0")}`,
      latitude: 13.0 + (i % 8) * 0.02,
      longitude: 80.15 + (i % 5) * 0.02,
    }),
  );
}

describe("hasUsableCoordinate", () => {
  it("rejects the directory's zero-pair 'unknown' marker", () => {
    expect(hasUsableCoordinate(office({ pincode: "600001", latitude: 0, longitude: 0 }))).toBe(false);
  });

  it("rejects coordinates outside India", () => {
    expect(hasUsableCoordinate(office({ pincode: "600001", latitude: 51.5, longitude: -0.12 }))).toBe(false);
  });

  it("rejects unparseable coordinates", () => {
    expect(hasUsableCoordinate(office({ pincode: "600001", latitude: Number.NaN, longitude: 80.1 }))).toBe(false);
  });

  it("accepts a normal Chennai point", () => {
    expect(hasUsableCoordinate(office({ pincode: "600001" }))).toBe(true);
  });
});

describe("resolvePincodeCoordinates", () => {
  it("outvotes the real Kolathur longitude typo", () => {
    // The exact rows that produced a 539km Kolathur under a mean centroid.
    const offices = [
      ...chennaiBackground(),
      office({
        pincode: "600099",
        officeName: "Kolathur SO",
        officeType: "PO",
        latitude: 13.1244722,
        longitude: 80.2137778,
      }),
      office({
        pincode: "600099",
        officeName: "Lakshmipuram BO",
        latitude: 13.116,
        longitude: 70.181, // should be 80.181
      }),
    ];

    const { resolved } = resolvePincodeCoordinates(offices);
    const kolathur = resolved.get("600099");

    expect(kolathur).toBeDefined();
    expect(kolathur!.longitude).toBeCloseTo(80.2137778, 4);
    expect(kolathur!.officesUsed).toBe(1);
    expect(kolathur!.officesTotal).toBe(2);
  });

  it("rejects a pincode outright when its only office is implausible", () => {
    // Vadapalani's single row has latitude 13.50 where it should be 13.05.
    // Nothing can outvote it, so the honest answer is no answer.
    const offices = [
      ...chennaiBackground(),
      office({
        pincode: "600026",
        officeName: "Vadapalani S.O",
        officeType: "PO",
        latitude: 13.5056389,
        longitude: 80.2145833,
      }),
    ];

    const { resolved, rejected } = resolvePincodeCoordinates(offices, { minimumGateKm: 10, gateSlack: 1 });

    expect(resolved.has("600026")).toBe(false);
    expect(rejected.find((r) => r.pincode === "600026")?.reason).toBe(
      "all office coordinates implausible",
    );
  });

  it("keeps the median stable when most offices agree", () => {
    const offices = [
      ...chennaiBackground(),
      office({ pincode: "600095", officeName: "Vanagaram BO", latitude: 13.047, longitude: 80.126 }),
      office({ pincode: "600095", officeName: "Ayanambakkam BO", latitude: 13.066, longitude: 80.123 }),
      // The coastline-snapped sub-office row.
      office({ pincode: "600095", officeName: "Maduravoyal SO", officeType: "PO", latitude: 13.118, longitude: 80.2894 }),
    ];

    const resolved = resolvePincodeCoordinates(offices).resolved.get("600095")!;

    expect(resolved.longitude).toBeLessThan(80.2);
    expect(resolved.latitude).toBeGreaterThan(13.04);
    expect(resolved.latitude).toBeLessThan(13.08);
  });

  it("refuses to answer when two offices disagree and neither can be outvoted", () => {
    // The real Mogappair rows. The median of two points is their MIDPOINT, so a
    // single corrupt row drags the answer halfway rather than losing the vote —
    // this resolved to 13.4km for a place 3.4km from the office, on 8 live calls.
    const offices = [
      ...chennaiBackground(),
      office({ pincode: "600037", officeName: "Mogappair SO", officeType: "PO", latitude: 13.0848056, longitude: 80.1831667 }),
      office({ pincode: "600037", officeName: "Mogappair West SO", officeType: "PO", latitude: 13.1460278, longitude: 80.2832778 }),
    ];

    // A loose gate on purpose: the real 600xxx prefix sprawls to the outer
    // suburbs and computes a ~35km gate, so BOTH rows survive it and the
    // small-sample rule is the only thing standing between the dispatcher and a
    // confident 13.4km. Testing it behind a tight gate would prove nothing.
    const { resolved, rejected } = resolvePincodeCoordinates(offices, { minimumGateKm: 40 });

    expect(resolved.has("600037")).toBe(false);
    expect(rejected.find((r) => r.pincode === "600037")?.reason).toBe(
      "too few offices to resolve a disagreement",
    );
  });

  it("still trusts a wide spread once three offices can vote", () => {
    // Red Hills genuinely sprawls: 9 offices, ~9km spread, and the answer is
    // right. The small-sample guard must not punish real rural geography.
    const offices = [
      ...chennaiBackground(),
      ...[
        [13.195, 80.08], [13.165, 80.127], [13.185, 80.189], [13.173, 80.171],
        [13.1957222, 80.1832778], [13.189, 80.112], [13.224, 80.053],
      ].map(([lat, lng]) => office({ pincode: "600052", latitude: lat!, longitude: lng! })),
    ];

    const resolved = resolvePincodeCoordinates(offices).resolved.get("600052");

    expect(resolved).toBeDefined();
    expect(resolved!.spreadKm).toBeGreaterThan(5);
    expect(resolved!.officesUsed).toBeGreaterThanOrEqual(3);
  });

  it("accepts two offices that agree with each other", () => {
    const offices = [
      ...chennaiBackground(),
      office({ pincode: "600033", latitude: 13.04, longitude: 80.22 }),
      office({ pincode: "600033", latitude: 13.045, longitude: 80.223 }),
    ];

    expect(resolvePincodeCoordinates(offices).resolved.has("600033")).toBe(true);
  });

  it("uses the town's main office, not the geometric centre of the villages", () => {
    // Red Hills: 8 branch offices scattered across farmland plus the sub-office
    // in the town. The median of all nine lands ~6km west of Red Hills itself,
    // which put its routed distance 5km over the truth. Service calls are in the
    // town, so the sub-office is the honest point.
    const offices = [
      ...chennaiBackground(),
      office({ pincode: "600052", officeName: "Redhills SO", officeType: "PO", latitude: 13.1957222, longitude: 80.1832778 }),
      ...[
        [13.195, 80.08], [13.165, 80.127], [13.185, 80.189], [13.173, 80.171],
        [13.189, 80.112], [13.224, 80.053], [13.2, 80.059],
      ].map(([lat, lng]) => office({ pincode: "600052", latitude: lat!, longitude: lng! })),
    ];

    const resolved = resolvePincodeCoordinates(offices).resolved.get("600052")!;

    expect(resolved.longitude).toBeCloseTo(80.1832778, 3);
    expect(resolved.latitude).toBeCloseTo(13.1957222, 3);
  });

  it("ignores a main office that disagrees with the branch offices", () => {
    // Maduravoyal's sub-office is snapped 18km away onto the coastline while its
    // branch offices are correct. Preferring the main office blindly would take
    // the one wrong row over the two right ones.
    const offices = [
      ...chennaiBackground(),
      office({ pincode: "600095", officeName: "Vanagaram BO", latitude: 13.047, longitude: 80.126 }),
      office({ pincode: "600095", officeName: "Ayanambakkam BO", latitude: 13.066, longitude: 80.123 }),
      office({ pincode: "600095", officeName: "Maduravoyal SO", officeType: "PO", latitude: 13.118, longitude: 80.2894 }),
    ];

    const resolved = resolvePincodeCoordinates(offices).resolved.get("600095")!;

    expect(resolved.longitude).toBeLessThan(80.2);
  });

  it("reports a pincode with no usable coordinates rather than dropping it", () => {
    const offices = [
      ...chennaiBackground(),
      office({ pincode: "600029", officeName: "Nowhere B.O", latitude: 0, longitude: 0 }),
    ];

    const { rejected } = resolvePincodeCoordinates(offices);

    expect(rejected.find((r) => r.pincode === "600029")?.reason).toBe("no usable coordinates");
  });

  it("names a pincode from its head office, not a branch office", () => {
    const offices = [
      ...chennaiBackground(),
      office({ pincode: "600053", officeName: "Oragadam B.O", latitude: 13.118, longitude: 80.126 }),
      office({ pincode: "600053", officeName: "Ambattur H.O", officeType: "HO", latitude: 13.113, longitude: 80.15 }),
    ];

    expect(resolvePincodeCoordinates(offices).resolved.get("600053")!.areaName).toBe("Ambattur");
  });

  it("ignores rows whose pincode is not six digits", () => {
    const offices = [...chennaiBackground(), office({ pincode: "60009" })];

    expect(resolvePincodeCoordinates(offices).resolved.has("60009")).toBe(false);
  });

  it("records the spread so a single-source pincode can be reviewed", () => {
    const offices = [
      ...chennaiBackground(),
      office({ pincode: "600051", officeName: "Madhavaram Milk Colony SO", officeType: "PO" }),
    ];

    const resolved = resolvePincodeCoordinates(offices).resolved.get("600051")!;

    expect(resolved.officesUsed).toBe(1);
    expect(resolved.spreadKm).toBe(0);
  });
});

describe("parseCsv", () => {
  it("keeps commas that sit inside quoted fields", () => {
    const rows = parseCsv('a,"b,c",d\n1,"2,3",4\n');

    expect(rows[0]).toEqual(["a", "b,c", "d"]);
    expect(rows[1]).toEqual(["1", "2,3", "4"]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('"say ""hi""",x\n')[0]).toEqual(['say "hi"', "x"]);
  });

  it("tolerates a missing trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toHaveLength(2);
  });
});

describe("readDirectoryCsv", () => {
  const header =
    "circlename,regionname,divisionname,officename,pincode,officetype,delivery,district,statename,latitude,longitude\n";

  it("reads the published data.gov.in column layout", () => {
    const csv =
      header +
      '"Tamil Nadu Circle","Chennai Region","Chennai Division","Kolathur SO",600099,PO,Delivery,"CHENNAI",TAMIL NADU,13.1244722,80.2137778\n';

    const offices = readDirectoryCsv(csv);

    expect(offices).toHaveLength(1);
    expect(offices[0]).toMatchObject({
      officeName: "Kolathur SO",
      pincode: "600099",
      officeType: "PO",
      district: "CHENNAI",
      latitude: 13.1244722,
    });
  });

  it("skips rows whose pincode is not six digits", () => {
    const csv = header + '"a","b","c","Bad Office",60,PO,Delivery,"X",TAMIL NADU,13.1,80.2\n';

    expect(readDirectoryCsv(csv)).toHaveLength(0);
  });

  it("fails loudly when the file is not the expected directory", () => {
    expect(() => readDirectoryCsv("pincode,area\n600001,Chennai\n")).toThrow(/missing the "officename" column/);
  });

  it("returns nothing for an empty file", () => {
    expect(readDirectoryCsv("")).toEqual([]);
  });
});
