import { z } from "zod";

function isValidDateOnly(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  return parsed.toISOString().slice(0, 10) === value;
}

// A report's business date can never be in the future. Rejecting it here is the
// authoritative stop: no client (including a stale tab whose 10s poll keeps
// re-generating an old, mis-dated session) can write a future report_date into
// the DB. One day of slack absorbs timezone skew for a report dated "today" in
// a timezone ahead of the server.
function isNotFutureDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  const cutoffMs = Date.now() + 24 * 60 * 60 * 1000;
  return parsed.getTime() <= cutoffMs;
}

export const reportGenerationRequestSchema = z.object({
  reportDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isValidDateOnly, "reportDate must be a valid YYYY-MM-DD date")
    .refine(isNotFutureDate, "reportDate cannot be in the future"),
  generatedBy: z.string().uuid(),
  regionId: z.string().uuid().nullable().optional(),
  flexUploadBatchId: z.string().uuid(),
  renderwaysUploadBatchId: z.string().uuid().nullable().optional(),
  callPlanUploadBatchId: z.string().uuid().nullable().optional(),
});

export type ReportGenerationRequestInput = z.infer<
  typeof reportGenerationRequestSchema
>;
