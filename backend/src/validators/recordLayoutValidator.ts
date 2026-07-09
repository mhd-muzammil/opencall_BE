import { z } from "zod";
import { DAILY_CALL_PLAN_COLUMNS } from "@opencall/shared";

const COLUMN_SET = new Set<string>(DAILY_CALL_PLAN_COLUMNS);

// The records-grid layout is an ordered list of visible report column keys.
// Every key must be a known report column, with no duplicates, and at least one
// column must remain visible.
export const recordLayoutSchema = z.object({
  orderedColumns: z
    .array(z.string())
    .min(1, "At least one column must be visible")
    .refine((cols) => cols.every((c) => COLUMN_SET.has(c)), {
      message: "Layout contains an unknown column",
    })
    .refine((cols) => new Set(cols).size === cols.length, {
      message: "Layout contains duplicate columns",
    }),
});
