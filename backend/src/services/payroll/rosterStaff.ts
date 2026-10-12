import type { RosterEngineer } from "./payrollClient.js";

/**
 * The live tracking board: our engineer register, and then the OTHER staff who
 * work at Renderways.
 *
 * The register stays exactly as it was -- the same rows, matched by Payroll the
 * same way, unmatched names still shown as "Not in Payroll". What is added is
 * Payroll's staff in other roles (RMA, call coordinators, IT, HR, ...), who
 * also log in with the Payroll app and go on duty, and whom the office asked to
 * see on the board too (12 Oct 2026). They are marked `staff`.
 *
 * Field engineers are NOT added here, whatever the register says about them.
 * They come onto the board through the register only -- the rule the office
 * kept. One the register cannot resolve stays "Not in Payroll" instead of also
 * coming back as staff under the Payroll spelling, which showed one person on
 * two rows; one who is not in the register is not on the board, as before.
 *
 * Anyone the register already resolved is not added a second time: identity is
 * Payroll's employee id, never the name ("Kausar Basha" here is
 * "Kausarbadshah M" there). And a row that says neither its department nor its
 * role -- a Payroll not yet redeployed -- is not added, because there is no
 * telling whether it is a field engineer.
 */

// How Payroll marks a field engineer: the FSE department, and the role names
// field engineers have carried ("FIELD ENGINEER" now, "Service engineer" on
// older records).
const FIELD_DEPARTMENTS = new Set(["fse"]);
const FIELD_ROLE = /\b(field|service)\s*engineer\b/i;

export function isFieldEngineer(row: Pick<RosterEngineer, "department" | "role">): boolean {
  const department = String(row.department ?? "").trim().toLowerCase();
  return FIELD_DEPARTMENTS.has(department) || FIELD_ROLE.test(String(row.role ?? ""));
}

const saysWhoTheyAre = (row: Pick<RosterEngineer, "department" | "role">): boolean =>
  Boolean(String(row.department ?? "").trim() || String(row.role ?? "").trim());

export function withStaff(
  register: readonly RosterEngineer[],
  everyone: readonly RosterEngineer[],
): RosterEngineer[] {
  const inRegister = new Set(
    register.map((row) => row.engineer_id).filter((id): id is number => id != null),
  );
  const staff = everyone
    .filter(
      (row) =>
        row.engineer_id != null &&
        !inRegister.has(row.engineer_id) &&
        saysWhoTheyAre(row) &&
        !isFieldEngineer(row),
    )
    .map((row) => ({ ...row, staff: true }));
  return [...register, ...staff].sort((a, b) =>
    a.engineer_name.localeCompare(b.engineer_name, "en", { sensitivity: "base" }),
  );
}
