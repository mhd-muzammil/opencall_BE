import type { EditedReportRow } from "../../repositories/dailyCallPlanReportRepository.js";
import { findEngineerByNameInRegion } from "../../repositories/engineerRepository.js";
import { dispatchCase, isPayrollConfigured } from "./payrollClient.js";

/**
 * When a report row is scheduled with an engineer in OpenCall, mirror it to the
 * Payroll app as a dispatched case so the engineer sees it and streams GPS.
 *
 * Fire-and-forget by design: it must NEVER block or fail the OpenCall save, so
 * every error is swallowed (logged only). Idempotent via external_ref = ticketId
 * — re-scheduling the same ticket updates the one Payroll case, not a duplicate.
 * No-op when Payroll isn't configured or the row has no engineer.
 */
export function dispatchAssignedCaseToPayroll(row: EditedReportRow): void {
  if (!isPayrollConfigured() || !row.engineer) return;

  const engineerName = row.engineer;

  void (async () => {
    // Resolve the engineer's email + phone from the engineers table so Payroll
    // can match on those (unique, reliable) rather than only the display name.
    let email: string | null = null;
    let phone: string | null = null;
    if (row.regionId) {
      const eng = await findEngineerByNameInRegion(engineerName, row.regionId);
      email = eng?.email ?? null;
      phone = eng?.phone ?? null;
    }

    const label = [row.part, row.segment].filter(Boolean).join(" - ") || "Service call";
    const title = `${label} (${row.ticketId})`.slice(0, 200);
    const description = [row.rca, row.remarks].filter(Boolean).join("\n");

    await dispatchCase(
      {
        customer_name: row.customerName ?? "Unknown",
        title,
        description,
        address: row.workLocation ?? row.location ?? "",
        priority: "medium",
        external_ref: row.ticketId,
      },
      { email, phone, name: engineerName },
    );
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(
      "[payroll] dispatchAssignedCase failed for ticket",
      row.ticketId,
      "-",
      err instanceof Error ? err.message : err,
    );
  });
}
