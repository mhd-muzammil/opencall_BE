import {
  ASP_CODE_REGION_MAP,
  acerTicketIdForCase,
  brandForTicketId,
  classifyProductivityStatus,
} from "@opencall/shared";
import { withTransaction } from "../../config/database.js";
import {
  deleteBrandCall,
  findBranchOfficeCoordinates,
  findBrandCallById,
  findBrandCallsByCaseIds,
  findPincodeGeo,
  insertBrandCalls,
  listBrandCalls,
  listRecentBrandCalls,
  reopenBrandCall,
  reviveBrandCall,
  setBrandCallClosure,
  updateBrandCallDetails,
  type BrandCall,
  type BrandCallListItem,
  type BrandCallListStatus,
  type NewBrandCall,
} from "../../repositories/brandCallRepository.js";
import { findRegionById } from "../../repositories/regionRepository.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { forbidden, notFound, unprocessableEntity } from "../../utils/httpError.js";
import { findAllowedRegionIdsForUser } from "../rbac/regionAccessService.js";
import { aspCodesForRegion } from "../rbac/regionRowAccess.js";
import { parseAcerCallsText, type ParsedAcerCall } from "./acerCallParser.js";

/** Most calls one paste may save — a day's calls, not an archive import. */
export const MAX_CALLS_PER_PASTE = 200;

export interface RegionSuggestion {
  /** ASP code of the branch, or "" when nothing pointed anywhere. */
  regionCode: string;
  /** Why, in words the admin understands. */
  reason: string;
}

export interface AcerCallPreview extends ParsedAcerCall {
  ticketId: string;
  regionCode: string;
  regionReason: string;
  /**
   * Set when the case is already on file. An open one is skipped; a closed or deleted
   * one is reopened with the pasted details if the admin ticks it.
   */
  existing: { createdAt: string; closedAt: string | null; deletedAt: string | null } | null;
}

export interface AcerPastePreview {
  calls: AcerCallPreview[];
  ignoredLines: { lineNumber: number; text: string }[];
  regions: { code: string; name: string }[];
}

const REGION_KEYWORDS: readonly [RegExp, string][] = [
  [/\bKANCH(?:EE|I)PURAM\b|\bKANCHI\b/, "ASPS01489"],
  [/\bCHENNAI\b/, "ASPS01461"],
  [/\bVELLORE\b/, "ASPS01463"],
  [/\bSALEM\b/, "ASPS01465"],
  [/\bHOSUR\b/, "ASPS01511"],
];

function regionFromText(text: string): string | null {
  const upper = text.toUpperCase();
  for (const [pattern, aspCode] of REGION_KEYWORDS) {
    if (pattern.test(upper)) {
      return aspCode;
    }
  }
  return null;
}

function kmBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function regionList(): { code: string; name: string }[] {
  return Object.entries(ASP_CODE_REGION_MAP).map(([code, name]) => ({
    code,
    name: name.charAt(0) + name.slice(1).toLowerCase(),
  }));
}

/**
 * Which branch should work each call. Acer writes the school's district into the
 * customer name ("33030206501 KANCHEEPURAM PUMS …"), which is the strongest hint; then
 * the pincode's district; then the branch office nearest the pincode. The admin can
 * change it on the preview before saving.
 */
async function suggestRegions(
  calls: readonly ParsedAcerCall[],
): Promise<Map<number, RegionSuggestion>> {
  const geoByPincode = await findPincodeGeo(calls.map((call) => call.pincode));
  const offices = await findBranchOfficeCoordinates();
  const suggestions = new Map<number, RegionSuggestion>();

  for (const call of calls) {
    const fromName = regionFromText(`${call.customerName} ${call.fullAddress}`);
    if (fromName) {
      suggestions.set(call.lineNumber, {
        regionCode: fromName,
        reason: "District named in the customer name / address",
      });
      continue;
    }

    const geo = geoByPincode.get(call.pincode);
    const fromDistrict = geo ? regionFromText(geo.district) : null;
    if (fromDistrict) {
      suggestions.set(call.lineNumber, {
        regionCode: fromDistrict,
        reason: `Pincode ${call.pincode} is in ${geo?.district ?? ""} district`,
      });
      continue;
    }

    if (geo && geo.latitude !== null && geo.longitude !== null && offices.length > 0) {
      const point = { latitude: geo.latitude, longitude: geo.longitude };
      const nearest = offices
        .filter((office) => ASP_CODE_REGION_MAP[office.aspCode])
        .map((office) => ({ office, km: kmBetween(point, office) }))
        .sort((a, b) => a.km - b.km)[0];
      if (nearest) {
        suggestions.set(call.lineNumber, {
          regionCode: nearest.office.aspCode,
          reason: `Nearest branch to pincode ${call.pincode} (~${Math.round(nearest.km)} km)`,
        });
        continue;
      }
    }

    suggestions.set(call.lineNumber, { regionCode: "", reason: "Pick the branch" });
  }

  return suggestions;
}

/** Reads a paste and says what saving it would do. Writes nothing. */
export async function previewAcerPaste(text: string): Promise<AcerPastePreview> {
  const parsed = parseAcerCallsText(text);
  if (parsed.calls.length > MAX_CALLS_PER_PASTE) {
    throw unprocessableEntity(
      `That is ${parsed.calls.length} calls; paste at most ${MAX_CALLS_PER_PASTE} at a time.`,
    );
  }

  const [suggestions, existing] = await Promise.all([
    suggestRegions(parsed.calls),
    findBrandCallsByCaseIds(
      "ACER",
      parsed.calls.map((call) => call.caseId).filter(Boolean),
    ),
  ]);
  const existingByCase = new Map(existing.map((call) => [call.caseId, call]));

  return {
    ignoredLines: parsed.ignoredLines,
    regions: regionList(),
    calls: parsed.calls.map((call) => {
      const suggestion = suggestions.get(call.lineNumber);
      const onFile = existingByCase.get(call.caseId);
      return {
        ...call,
        ticketId: call.caseId ? acerTicketIdForCase(call.caseId) : "",
        regionCode: suggestion?.regionCode ?? "",
        regionReason: suggestion?.reason ?? "",
        existing: onFile
          ? { createdAt: onFile.createdAt, closedAt: onFile.closedAt, deletedAt: onFile.deletedAt }
          : null,
      };
    }),
  };
}

export interface AcerCallInput {
  caseId?: unknown;
  customerName?: unknown;
  callStatus?: unknown;
  serviceType?: unknown;
  model?: unknown;
  productCategory?: unknown;
  serialNumber?: unknown;
  issueDescription?: unknown;
  warrantyStatus?: unknown;
  fullAddress?: unknown;
  pincode?: unknown;
  primaryContact?: unknown;
  altContact?: unknown;
  regionCode?: unknown;
  sourceLine?: unknown;
}

function text(value: unknown, max = 1000): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

export interface CreateAcerCallsResult {
  created: BrandCall[];
  /** Closed or deleted cases pasted again: reopened with the pasted details. */
  reopened: BrandCall[];
  /** Case ids skipped because they are already open. */
  skippedExisting: string[];
}

/**
 * Saves the calls the admin confirmed on the preview (possibly edited there). Every
 * call is checked again here — the browser is not trusted — and nothing is saved when
 * any call is invalid, so a half-saved paste never needs untangling.
 */
export async function createAcerCalls(
  inputs: readonly AcerCallInput[],
  actor: string,
): Promise<CreateAcerCallsResult> {
  if (inputs.length === 0) {
    throw unprocessableEntity("No calls to save.");
  }
  if (inputs.length > MAX_CALLS_PER_PASTE) {
    throw unprocessableEntity(`Save at most ${MAX_CALLS_PER_PASTE} calls at a time.`);
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  const calls: NewBrandCall[] = inputs.map((input, index) => {
    const caseId = text(input.caseId, 64).toUpperCase();
    const regionCode = text(input.regionCode, 32).toUpperCase();
    const label = caseId || `call ${index + 1}`;
    if (!caseId) {
      problems.push(`Call ${index + 1}: Case ID is missing.`);
    } else if (!/^[A-Z0-9][A-Z0-9/_-]*$/.test(caseId)) {
      problems.push(`${label}: Case ID may only hold letters, digits, "-", "_" and "/".`);
    } else if (seen.has(caseId)) {
      problems.push(`${label}: listed twice.`);
    }
    seen.add(caseId);
    if (!text(input.customerName)) {
      problems.push(`${label}: Customer Name is missing.`);
    }
    if (!ASP_CODE_REGION_MAP[regionCode]) {
      problems.push(`${label}: pick the branch (region) that will work the call.`);
    }
    return {
      caseId,
      ticketId: caseId ? acerTicketIdForCase(caseId) : "",
      regionCode,
      customerName: text(input.customerName, 300),
      callStatus: text(input.callStatus, 200),
      serviceType: text(input.serviceType, 200),
      model: text(input.model, 200),
      productCategory: text(input.productCategory, 200),
      serialNumber: text(input.serialNumber, 200),
      issueDescription: text(input.issueDescription, 1000),
      warrantyStatus: text(input.warrantyStatus, 200),
      fullAddress: text(input.fullAddress, 1000),
      pincode: text(input.pincode, 16),
      primaryContact: text(input.primaryContact, 64),
      altContact: text(input.altContact, 64),
      sourceLine: text(input.sourceLine, 4000),
    };
  });

  if (problems.length > 0) {
    throw unprocessableEntity("Some calls cannot be saved. Nothing was saved.", { problems });
  }

  return withTransaction(async (client) => {
    const created = await insertBrandCalls(client, "ACER", calls, actor);
    const createdCases = new Set(created.map((call) => call.caseId));
    const reopened: BrandCall[] = [];
    const skippedExisting: string[] = [];
    for (const call of calls) {
      if (createdCases.has(call.caseId)) continue;
      const revived = await reviveBrandCall(client, "ACER", call, actor, isClosedStatus);
      if (revived) {
        reopened.push(revived);
      } else {
        skippedExisting.push(call.caseId);
      }
    }
    return { created, reopened, skippedExisting };
  });
}

export async function listRecentAcerCalls(limit = 50): Promise<BrandCall[]> {
  return listRecentBrandCalls("ACER", Math.min(Math.max(limit, 1), 500));
}

function isClosedStatus(status: string): boolean {
  const text = status.trim();
  return text !== "" && classifyProductivityStatus(text) === "CLOSED";
}

/**
 * The ASP codes a user's Acer calls are limited to: null for a SUPER_ADMIN (all), the
 * codes of every region a REGION_ADMIN holds otherwise — the same regions their Records
 * rows are limited to.
 */
async function allowedAspCodes(user: AuthenticatedUser): Promise<string[] | null> {
  const regionIds = await findAllowedRegionIdsForUser(user);
  if (regionIds === null) {
    return null;
  }
  const codes = new Set<string>();
  for (const regionId of regionIds) {
    const region = await findRegionById(regionId);
    if (region) {
      for (const code of aspCodesForRegion(region)) codes.add(code.toUpperCase());
    }
  }
  return [...codes];
}

export async function listAcerCalls(input: {
  user: AuthenticatedUser;
  status: BrandCallListStatus;
  search: string;
  limit: number;
}): Promise<BrandCallListItem[]> {
  return listBrandCalls({
    brand: "ACER",
    status: input.status,
    regionCodes: await allowedAspCodes(input.user),
    search: input.search,
    limit: Math.min(Math.max(Math.trunc(input.limit) || 200, 1), 1000),
  });
}

async function requireCallInUsersRegions(user: AuthenticatedUser, id: string): Promise<BrandCall> {
  const call = await findBrandCallById(id);
  if (!call || call.deletedAt || call.brand !== "ACER") {
    throw notFound("That Acer call does not exist.");
  }
  const codes = await allowedAspCodes(user);
  if (codes !== null && !codes.includes(call.regionCode.toUpperCase())) {
    throw forbidden("That Acer call belongs to another region.");
  }
  return call;
}

/**
 * Corrects a saved call (SUPER_ADMIN). Every field but the Case ID can change — the case
 * id is the call's ticket ("ACER-<case id>") on every report, so a wrong one is fixed by
 * deleting the call and pasting it again.
 */
export async function updateAcerCall(
  id: string,
  input: AcerCallInput,
  actor: string,
): Promise<BrandCall> {
  const regionCode = text(input.regionCode, 32).toUpperCase();
  const problems: string[] = [];
  if (!text(input.customerName)) problems.push("Customer Name is missing.");
  if (!ASP_CODE_REGION_MAP[regionCode]) problems.push("Pick the branch (region) that will work the call.");
  if (problems.length > 0) {
    throw unprocessableEntity("The call cannot be saved.", { problems });
  }
  const updated = await withTransaction((client) =>
    updateBrandCallDetails(
      client,
      id,
      {
        regionCode,
        customerName: text(input.customerName, 300),
        callStatus: text(input.callStatus, 200),
        serviceType: text(input.serviceType, 200),
        model: text(input.model, 200),
        productCategory: text(input.productCategory, 200),
        serialNumber: text(input.serialNumber, 200),
        issueDescription: text(input.issueDescription, 1000),
        warrantyStatus: text(input.warrantyStatus, 200),
        fullAddress: text(input.fullAddress, 1000),
        pincode: text(input.pincode, 16),
        primaryContact: text(input.primaryContact, 64),
        altContact: text(input.altContact, 64),
      },
      actor,
    ),
  );
  if (!updated) {
    throw notFound("That Acer call does not exist.");
  }
  return updated;
}

/** Deletes a call entered by mistake (SUPER_ADMIN). See deleteBrandCall. */
export async function deleteAcerCall(id: string, actor: string): Promise<BrandCall> {
  const deleted = await withTransaction((client) => deleteBrandCall(client, id, actor));
  if (!deleted) {
    throw notFound("That Acer call does not exist or is already deleted.");
  }
  return deleted;
}

/**
 * Reopens a closed call — closed by mistake, or the customer called back. Whoever can
 * work the call may do it: a SUPER_ADMIN, or a REGION_ADMIN for a call in their regions.
 */
export async function reopenAcerCall(input: {
  user: AuthenticatedUser;
  id: string;
}): Promise<BrandCall> {
  const call = await requireCallInUsersRegions(input.user, input.id);
  if (!call.closedAt) {
    throw unprocessableEntity("That Acer call is already open.");
  }
  const actor = input.user.username ?? input.user.email ?? input.user.id;
  const reopened = await withTransaction((client) =>
    reopenBrandCall(client, input.id, actor, isClosedStatus),
  );
  if (!reopened) {
    throw unprocessableEntity("That Acer call could not be reopened.");
  }
  return reopened;
}

/**
 * Keeps an Acer call's open/closed state in step with its report row. Acer sends no
 * file that says a call closed, so the team's status is the authority: a CLOSED-bucket
 * Morning or Evening status closes it (the generator stops adding it and the
 * carry-forward closes it like an HP call that left Flex), and moving the status off
 * CLOSED again reopens it. Rows of HP calls are ignored.
 *
 * Never throws: a failure here must not fail the status save that triggered it.
 */
export async function syncBrandCallClosureFromRow(input: {
  ticketId: string | null;
  rtplStatus: string | null;
  eveningRtplStatus: string | null;
  actor: string;
}): Promise<void> {
  const ticketId = (input.ticketId ?? "").trim();
  if (!ticketId || brandForTicketId(ticketId) === "HP") {
    return;
  }
  // The Evening is today's outcome and wins when set; otherwise the Morning.
  const status = (input.eveningRtplStatus ?? "").trim() || (input.rtplStatus ?? "").trim();
  const closed = status !== "" && classifyProductivityStatus(status) === "CLOSED";
  try {
    await setBrandCallClosure({
      ticketId,
      closedStatus: closed ? status : null,
      actor: input.actor,
    });
  } catch (error) {
    console.error("[brandCalls] could not sync closure from report row", { ticketId, error });
  }
}
