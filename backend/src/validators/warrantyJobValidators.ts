import { z } from "zod";

/** `:id` path param for every `/warranty/jobs/:id` route. */
export const warrantyJobIdParamSchema = z.object({
  id: z.string().uuid("Warranty job id must be a UUID"),
});

export type WarrantyJobIdParam = z.infer<typeof warrantyJobIdParamSchema>;
