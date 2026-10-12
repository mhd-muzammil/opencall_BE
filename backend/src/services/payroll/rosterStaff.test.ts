import { describe, expect, it } from "vitest";
import type { RosterEngineer } from "./payrollClient.js";
import { isFieldEngineer, withStaff } from "./rosterStaff.js";

function row(name: string, id: number | null, extra: Partial<RosterEngineer> = {}): RosterEngineer {
  return {
    engineer_name: name,
    engineer_id: id,
    state: id == null ? "unmatched" : "absent",
    ...extra,
  } as RosterEngineer;
}

describe("withStaff", () => {
  const register = [
    row("Kausar Basha", 7, { payroll_name: "Kausarbadshah M", state: "on_duty" }),
    row("Lava", 3),
    row("lingeswaran", null),
  ];
  const everyone = [
    row("Kausarbadshah M", 7, { state: "on_duty", department: "FSE", role: "FIELD ENGINEER" }),
    row("LAVAKUMAR", 3, { department: "FSE", role: "FIELD ENGINEER" }),
    // The register's "lingeswaran" is this person, under the Payroll spelling.
    row("Lingeshwaran M", 9, { department: "FSE", role: "FIELD ENGINEER" }),
    // A field engineer the register does not list at all.
    row("New Joiner", 10, { department: "FSE", role: "FIELD ENGINEER" }),
    row("Swetha", 21, { department: "BACKEND SUPPORT", role: "CALL COORDINATOR", state: "on_duty" }),
    row("chakree R", 22, { department: "HR", role: "Human Resource" }),
    row("Agalya A", 23, { department: "RMA", role: "RMA Executive" }),
  ];

  it("keeps every register row exactly as it was", () => {
    const merged = withStaff(register, everyone);
    for (const original of register) {
      expect(merged).toContainEqual(original);
    }
    expect(merged.find((r) => r.engineer_name === "lingeswaran")?.state).toBe("unmatched");
  });

  it("adds the staff in other roles, marked as staff", () => {
    const staff = withStaff(register, everyone).filter((r) => r.staff);
    expect(staff.map((r) => r.engineer_name)).toEqual(["Agalya A", "chakree R", "Swetha"]);
    expect(staff.find((r) => r.engineer_name === "Swetha")?.state).toBe("on_duty");
  });

  it("never adds a field engineer: they come through the register or not at all", () => {
    const names = withStaff(register, everyone).map((r) => r.engineer_name);
    // An unmatched register engineer is not shown a second time as staff...
    expect(names).not.toContain("Lingeshwaran M");
    // ...and one the register does not list stays off the board, as before.
    expect(names).not.toContain("New Joiner");
  });

  it("never adds somebody the register already has, whatever the spelling", () => {
    const merged = withStaff(register, everyone);
    expect(merged.filter((r) => r.engineer_id === 7)).toHaveLength(1);
    expect(merged.filter((r) => r.engineer_id === 3)).toHaveLength(1);
    expect(merged.find((r) => r.engineer_id === 7)?.engineer_name).toBe("Kausar Basha");
  });

  it("adds nobody from a Payroll that does not say department or role", () => {
    const old = [row("Kausarbadshah M", 7), row("Swetha", 21), row("New Joiner", 10)];
    expect(withStaff(register, old)).toEqual(
      [...register].sort((a, b) => a.engineer_name.localeCompare(b.engineer_name, "en", { sensitivity: "base" })),
    );
  });

  it("sorts the board by name, ignoring case", () => {
    const names = withStaff(register, everyone).map((r) => r.engineer_name);
    expect(names).toEqual(["Agalya A", "chakree R", "Kausar Basha", "Lava", "lingeswaran", "Swetha"]);
  });

  it("with no staff to add, is the register", () => {
    expect(withStaff(register, []).map((r) => r.engineer_name)).toEqual(["Kausar Basha", "Lava", "lingeswaran"]);
  });
});

describe("isFieldEngineer", () => {
  it("knows a field engineer by the FSE department or the role", () => {
    expect(isFieldEngineer({ department: "FSE", role: null })).toBe(true);
    expect(isFieldEngineer({ department: " fse ", role: "" })).toBe(true);
    expect(isFieldEngineer({ department: null, role: "FIELD ENGINEER" })).toBe(true);
    expect(isFieldEngineer({ department: "", role: "Service engineer" })).toBe(true);
  });

  it("and nobody else", () => {
    expect(isFieldEngineer({ department: "RMA", role: "RMA Executive" })).toBe(false);
    expect(isFieldEngineer({ department: "IT", role: "SOFTWARE DEVELOPER" })).toBe(false);
    expect(isFieldEngineer({ department: "BACKEND SUPPORT", role: "CALL COORDINATOR" })).toBe(false);
    expect(isFieldEngineer({ department: null, role: null })).toBe(false);
  });
});
