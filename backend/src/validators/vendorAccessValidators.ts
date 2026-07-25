import { z } from "zod";
import {
  VENDOR_ACCESS_SECTION_KEYS,
  VENDOR_ACCESS_PERMISSION_LEVEL_VALUES,
} from "@opencall/shared";

const permissionLevelSchema = z.enum(
  VENDOR_ACCESS_PERMISSION_LEVEL_VALUES as [string, ...string[]],
);

const sectionKeySchema = z
  .string()
  .refine((v) => VENDOR_ACCESS_SECTION_KEYS.includes(v), {
    message: "Unknown vendor section key",
  });

const sectionsSchema = z.array(sectionKeySchema);

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, "Username may use letters, numbers, dot, underscore, hyphen");

const passwordSchema = z.string().min(8).max(200);

export const createVendorAccessSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  sections: sectionsSchema.min(1, "Grant at least one vendor view"),
  permissionLevel: permissionLevelSchema.default("view"),
});

export const updateVendorAccessSchema = z
  .object({
    sections: sectionsSchema.min(1).optional(),
    permissionLevel: permissionLevelSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });

export const resetVendorPasswordSchema = z.object({
  password: passwordSchema,
});

export const assignCasesSchema = z.object({
  cases: z
    .array(
      z.object({
        ticketId: z.string().trim().min(1),
        caseId: z.string().trim().optional(),
      }),
    )
    .min(1, "Select at least one case to assign"),
});

export const idParamSchema = z.object({
  id: z.string().uuid(),
});

export const assignmentIdParamSchema = z.object({
  id: z.string().uuid(),
  assignmentId: z.string().uuid(),
});
