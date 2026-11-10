import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import { isPayrollConfigured } from "../services/payroll/payrollClient.js";
import { fetchAttendanceRecords, fetchPayslips, parseReportsRange } from "../services/payroll/reportsHub.js";

/**
 * The Reports section's Payroll reads: the attendance register and the
 * payslips for a date range. Read-only, SUPER_ADMIN only (see the routes), and
 * the Payroll credentials never leave the server.
 */

export const getReportsAttendanceController: RequestHandler = asyncHandler(async (request, response) => {
  const range = parseReportsRange(request.query.from, request.query.to);
  if (!range.ok) throw badRequest(range.message);
  if (!isPayrollConfigured()) {
    response.json({ data: { configured: false, records: [] } });
    return;
  }
  const records = await fetchAttendanceRecords(range.from, range.to);
  response.json({ data: { configured: true, records } });
});

export const getReportsPayslipsController: RequestHandler = asyncHandler(async (request, response) => {
  const range = parseReportsRange(request.query.from, request.query.to);
  if (!range.ok) throw badRequest(range.message);
  if (!isPayrollConfigured()) {
    response.json({ data: { configured: false, payslips: [] } });
    return;
  }
  const payslips = await fetchPayslips(range.from, range.to);
  response.json({ data: { configured: true, payslips } });
});
