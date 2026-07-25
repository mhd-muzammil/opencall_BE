import bcrypt from "bcryptjs";
import type { VendorAccessPermissionLevel } from "@opencall/shared";
import {
  deleteVendorAccess,
  findVendorAccessById,
  insertVendorAccess,
  listVendorAccess,
  updateVendorAccess,
  type VendorAccessRecord,
} from "../../repositories/vendorAccessRepository.js";
import {
  assignCasesToVendor,
  countAssignmentsByVendor,
  listAssignmentsForVendor,
  unassignCaseFromVendor,
  type AssignCaseInput,
  type VendorCaseAssignment,
} from "../../repositories/vendorCaseAssignmentRepository.js";
import { conflict, notFound } from "../../utils/httpError.js";

const BCRYPT_ROUNDS = 12;

/** Maps a Postgres unique-violation into a clean 409. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

export interface VendorAccessListItem extends VendorAccessRecord {
  assignedCases: number;
}

export async function getVendorList(): Promise<VendorAccessListItem[]> {
  const [vendors, counts] = await Promise.all([
    listVendorAccess(),
    countAssignmentsByVendor(),
  ]);
  return vendors.map((v) => ({ ...v, assignedCases: counts.get(v.id) ?? 0 }));
}

export async function getVendor(id: string): Promise<VendorAccessRecord> {
  const vendor = await findVendorAccessById(id);
  if (!vendor) throw notFound("Vendor login not found");
  return vendor;
}

export async function createVendorLogin(input: {
  username: string;
  password: string;
  sections: string[];
  permissionLevel: VendorAccessPermissionLevel;
  createdBy: string;
}): Promise<VendorAccessRecord> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  try {
    return await insertVendorAccess({
      username: input.username,
      passwordHash,
      sections: input.sections,
      permissionLevel: input.permissionLevel,
      createdBy: input.createdBy,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("A vendor login with that username already exists");
    }
    throw error;
  }
}

export async function editVendorLogin(
  id: string,
  input: {
    sections?: string[];
    permissionLevel?: VendorAccessPermissionLevel;
    isActive?: boolean;
    updatedBy: string;
  },
): Promise<VendorAccessRecord> {
  const updated = await updateVendorAccess(id, input);
  if (!updated) throw notFound("Vendor login not found");
  return updated;
}

export async function resetVendorPassword(
  id: string,
  password: string,
  updatedBy: string,
): Promise<VendorAccessRecord> {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const updated = await updateVendorAccess(id, { passwordHash, updatedBy });
  if (!updated) throw notFound("Vendor login not found");
  return updated;
}

export async function removeVendorLogin(id: string): Promise<void> {
  const removed = await deleteVendorAccess(id);
  if (!removed) throw notFound("Vendor login not found");
}

export async function assignCases(
  vendorId: string,
  cases: readonly AssignCaseInput[],
  assignedBy: string,
): Promise<{ assigned: number }> {
  await getVendor(vendorId); // 404 if the vendor does not exist
  const assigned = await assignCasesToVendor(vendorId, cases, assignedBy);
  return { assigned };
}

export async function unassignCase(
  vendorId: string,
  assignmentId: string,
): Promise<void> {
  const removed = await unassignCaseFromVendor(vendorId, assignmentId);
  if (!removed) throw notFound("Case assignment not found");
}

export async function listVendorAssignments(
  vendorId: string,
): Promise<VendorCaseAssignment[]> {
  await getVendor(vendorId);
  return listAssignmentsForVendor(vendorId);
}
