import { z } from "zod";

// The records-grid layout is an ordered list of visible column keys. Keys may be
// standard report columns OR raw Excel headers (which vary per uploaded file and
// so cannot be validated against a fixed list), hence we validate shape only:
// non-empty trimmed strings, at least one, no duplicates, bounded length.
export const recordLayoutSchema = z.object({
  orderedColumns: z
    .array(z.string().trim().min(1).max(120))
    .min(1, "At least one column must be visible")
    .max(200, "Too many columns")
    .refine((cols) => new Set(cols).size === cols.length, {
      message: "Layout contains duplicate columns",
    }),
});
