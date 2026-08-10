/**
 * Turns the All India Pincode Directory into one trustworthy coordinate per
 * pincode.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The directory lists every post office with a latitude and longitude, several
 * offices per pincode. A meaningful minority of those coordinates are wrong, and
 * the errors are large rather than subtle. Observed in Tamil Nadu:
 *
 *   600099  Kolathur SO       13.1244  80.2137   correct
 *           Lakshmipuram BO   13.1160  70.1810   longitude 70 should be 80
 *   600026  Vadapalani S.O    13.5056  80.2145   latitude 13.50 should be 13.05
 *   600095  Maduravoyal SO    13.1180  80.2894   snapped onto the coastline
 *
 * Averaging the offices in a pincode lets one bad row destroy the answer:
 * Kolathur, a 12km call, came out at 539km — the midpoint of a real coordinate
 * and one sitting in the Arabian Sea.
 *
 * THE ESTIMATOR
 * -------------
 * 1. Anchor each 3-digit pincode prefix (the postal sorting district) on the
 *    median of its offices. Hundreds of offices per prefix makes that median
 *    immune to the scattered typos.
 * 2. Trust an office only if it lies within an ADAPTIVE radius of that anchor.
 *    The radius comes from the prefix's own 85th-percentile spread, so a dense
 *    urban prefix gets a tight gate and a sprawling rural one gets a loose
 *    one — no single fixed threshold can serve both.
 * 3. Take the median of the survivors.
 *
 * Once three or more offices survive, a wide spread is not a warning: it means
 * an outlier was outvoted, which is the estimator working. Two or fewer
 * survivors leave the answer unguarded, which is what `officesUsed` reports so
 * a human can review those specifically.
 *
 * A pincode whose offices are ALL rejected resolves to null. It is then entered
 * by hand with source='manual'. A blank distance is honest; a fabricated one
 * silently mis-ranks a dispatcher's morning.
 */

import { haversineKm } from "../../utils/geo.js";

/** One post-office row, as read from the directory CSV. */
export interface DirectoryOffice {
  officeName: string;
  pincode: string;
  officeType: string;
  district: string;
  stateName: string;
  latitude: number;
  longitude: number;
}

export interface ResolvedPincode {
  pincode: string;
  latitude: number;
  longitude: number;
  areaName: string;
  district: string;
  stateName: string;
  /** Offices that survived the plausibility gate and formed the median. */
  officesUsed: number;
  /** Offices that carried a syntactically usable coordinate at all. */
  officesTotal: number;
  /** Furthest survivor from the chosen point, in km. */
  spreadKm: number;
}

export interface RejectedPincode {
  pincode: string;
  areaName: string;
  officesTotal: number;
  reason:
    | "no usable coordinates"
    | "all office coordinates implausible"
    | "too few offices to resolve a disagreement";
}

export interface DirectoryResolution {
  resolved: Map<string, ResolvedPincode>;
  rejected: RejectedPincode[];
}

export interface ResolveOptions {
  /** Smallest gate radius, so a tightly-clustered prefix stays workable. */
  minimumGateKm?: number;
  /** Multiplier on the prefix's p85 spread. */
  gateSlack?: number;
}

/**
 * A coordinate can be absent, zero, or plainly outside India. Zero pairs are the
 * directory's "unknown" marker and would otherwise place a call in the Gulf of
 * Guinea.
 */
export function hasUsableCoordinate(office: DirectoryOffice): boolean {
  const { latitude: lat, longitude: lng } = office;

  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat !== 0 &&
    lng !== 0 &&
    lat > 6 &&
    lat < 38 &&
    lng > 68 &&
    lng < 98
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;

  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

/**
 * How far apart two offices in the SAME pincode can credibly sit. Beyond this
 * they are not describing one delivery area, so at least one of them is wrong.
 * Chennai pincodes span a few kilometres; rural ones are larger, which is why
 * this only gates samples too small to vote (see resolvePincodeCoordinates).
 */
const MAX_CREDIBLE_PINCODE_RADIUS_KM = 5;

/** Office-name suffixes that are postal bookkeeping, not part of the place name. */
const OFFICE_SUFFIX = /\s+(B\.O|S\.O|H\.O|P\.O|BO|SO|HO|PO)$/i;

/**
 * Head and sub offices — the town's main post office. Used both for naming and,
 * when it agrees with the median, for the coordinate itself.
 */
const MAIN_OFFICE_TYPES = new Set(["HO", "SO", "PO"]);

/**
 * How far a main office may sit from the median of all offices and still be
 * believed. Wide enough for a genuinely spread-out rural pincode (Red Hills is
 * 6km), tight enough to reject a corrupt row (Maduravoyal's is 18km out).
 */
const MAIN_OFFICE_AGREEMENT_KM = 8;

/** Head office beats sub-office beats branch office when naming the pincode. */
const OFFICE_TYPE_RANK: Record<string, number> = { HO: 0, SO: 1, PO: 1, BO: 2 };

function pickNamingOffice(offices: DirectoryOffice[]): DirectoryOffice {
  return [...offices].sort(
    (a, b) =>
      (OFFICE_TYPE_RANK[a.officeType] ?? 3) - (OFFICE_TYPE_RANK[b.officeType] ?? 3),
  )[0]!;
}

interface PrefixAnchor {
  latitude: number;
  longitude: number;
  gateKm: number;
}

function buildPrefixAnchors(
  offices: DirectoryOffice[],
  minimumGateKm: number,
  gateSlack: number,
): Map<string, PrefixAnchor> {
  const byPrefix = new Map<string, DirectoryOffice[]>();

  for (const office of offices) {
    if (!hasUsableCoordinate(office)) continue;
    const prefix = office.pincode.slice(0, 3);
    const bucket = byPrefix.get(prefix);
    if (bucket) bucket.push(office);
    else byPrefix.set(prefix, [office]);
  }

  const anchors = new Map<string, PrefixAnchor>();

  for (const [prefix, group] of byPrefix) {
    const latitude = median(group.map((o) => o.latitude));
    const longitude = median(group.map((o) => o.longitude));
    const distances = group.map((o) =>
      haversineKm({ latitude, longitude }, { latitude: o.latitude, longitude: o.longitude }),
    );

    anchors.set(prefix, {
      latitude,
      longitude,
      gateKm: Math.max(minimumGateKm, percentile(distances, 0.85) * gateSlack),
    });
  }

  return anchors;
}

/**
 * Resolve every pincode in the directory to a single coordinate, reporting the
 * ones that could not be resolved rather than guessing at them.
 */
export function resolvePincodeCoordinates(
  offices: DirectoryOffice[],
  options: ResolveOptions = {},
): DirectoryResolution {
  const minimumGateKm = options.minimumGateKm ?? 10;
  const gateSlack = options.gateSlack ?? 1.5;
  const anchors = buildPrefixAnchors(offices, minimumGateKm, gateSlack);

  const byPincode = new Map<string, DirectoryOffice[]>();
  for (const office of offices) {
    if (!/^[0-9]{6}$/.test(office.pincode)) continue;
    const bucket = byPincode.get(office.pincode);
    if (bucket) bucket.push(office);
    else byPincode.set(office.pincode, [office]);
  }

  const resolved = new Map<string, ResolvedPincode>();
  const rejected: RejectedPincode[] = [];

  for (const [pincode, group] of byPincode) {
    const naming = pickNamingOffice(group);
    const areaName = naming.officeName.replace(OFFICE_SUFFIX, "").trim();
    const usable = group.filter(hasUsableCoordinate);

    if (usable.length === 0) {
      rejected.push({
        pincode,
        areaName,
        officesTotal: 0,
        reason: "no usable coordinates",
      });
      continue;
    }

    const anchor = anchors.get(pincode.slice(0, 3));
    const survivors = anchor
      ? usable.filter(
          (o) =>
            haversineKm(anchor, { latitude: o.latitude, longitude: o.longitude }) <=
            anchor.gateKm,
        )
      : usable;

    if (survivors.length === 0) {
      rejected.push({
        pincode,
        areaName,
        officesTotal: usable.length,
        reason: "all office coordinates implausible",
      });
      continue;
    }

    // The geometric centre of a pincode is not where its customers are. A large
    // pincode's branch offices sit in outlying villages and drag the median away
    // from the town: Red Hills resolved 6km west of Red Hills itself, which put
    // its routed distance 5km over the real one.
    //
    // The head/sub office is the town's main post office, so it is a far better
    // proxy for where service calls actually land. It is only trusted when it
    // agrees with the median, because a corrupt main-office row is exactly the
    // failure this file exists to survive — Maduravoyal's sub-office is snapped
    // 18km away onto the coastline, and its branch offices are the honest ones.
    const mainOffices = survivors.filter((o) => MAIN_OFFICE_TYPES.has(o.officeType));
    const medianPoint = {
      latitude: median(survivors.map((o) => o.latitude)),
      longitude: median(survivors.map((o) => o.longitude)),
    };
    const trustedMain = mainOffices.filter(
      (o) =>
        haversineKm(medianPoint, { latitude: o.latitude, longitude: o.longitude }) <=
        MAIN_OFFICE_AGREEMENT_KM,
    );

    const latitude = trustedMain.length
      ? median(trustedMain.map((o) => o.latitude))
      : medianPoint.latitude;
    const longitude = trustedMain.length
      ? median(trustedMain.map((o) => o.longitude))
      : medianPoint.longitude;

    const spreadKm = survivors.reduce(
      (worst, o) =>
        Math.max(
          worst,
          haversineKm(
            { latitude, longitude },
            { latitude: o.latitude, longitude: o.longitude },
          ),
        ),
      0,
    );

    // A median needs three points to outvote anything. With two, the median IS
    // their midpoint — so one corrupt row does not lose the vote, it drags the
    // answer halfway to itself. That is the most dangerous failure mode here,
    // because the result stays plausible: Mogappair, 3.4km from the Maduravoyal
    // office, resolved to 13.4km this way on 8 live calls.
    //
    // So when a small sample disagrees with itself by more than a pincode can
    // credibly span, refuse to answer and let a human place it.
    if (survivors.length <= 2 && spreadKm > MAX_CREDIBLE_PINCODE_RADIUS_KM) {
      rejected.push({
        pincode,
        areaName,
        officesTotal: usable.length,
        reason: "too few offices to resolve a disagreement",
      });
      continue;
    }

    resolved.set(pincode, {
      pincode,
      latitude,
      longitude,
      areaName,
      district: naming.district,
      stateName: naming.stateName,
      officesUsed: survivors.length,
      officesTotal: usable.length,
      spreadKm,
    });
  }

  return { resolved, rejected };
}

/**
 * Minimal RFC-4180 reader. The directory ships as a 23MB CSV whose office,
 * district and state fields are quoted and contain commas, so a split(",") loses
 * column alignment on thousands of rows.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      rows.push(record);
      record = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field !== "" || record.length > 0) {
    record.push(field);
    rows.push(record);
  }

  return rows;
}

/** Column headers as published by data.gov.in. */
const REQUIRED_COLUMNS = [
  "officename",
  "pincode",
  "officetype",
  "district",
  "statename",
  "latitude",
  "longitude",
] as const;

export function readDirectoryCsv(text: string): DirectoryOffice[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const index: Record<string, number> = {};

  for (const column of REQUIRED_COLUMNS) {
    const at = header.indexOf(column);
    if (at === -1) {
      throw new Error(
        `Pincode directory is missing the "${column}" column. Found: ${header.join(", ")}`,
      );
    }
    index[column] = at;
  }

  const offices: DirectoryOffice[] = [];

  for (const row of rows.slice(1)) {
    if (row.length < REQUIRED_COLUMNS.length) continue;

    const pincode = String(row[index.pincode!] ?? "").replace(/\D/g, "");
    if (pincode.length !== 6) continue;

    offices.push({
      officeName: (row[index.officename!] ?? "").trim(),
      pincode,
      officeType: (row[index.officetype!] ?? "").trim().toUpperCase(),
      district: (row[index.district!] ?? "").trim(),
      stateName: (row[index.statename!] ?? "").trim(),
      latitude: Number.parseFloat(row[index.latitude!] ?? ""),
      longitude: Number.parseFloat(row[index.longitude!] ?? ""),
    });
  }

  return offices;
}
