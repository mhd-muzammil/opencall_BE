import { z } from "zod";
import { SPECIAL_ACCESS_SECTION_KEYS } from "@opencall/shared";

const dataScopeSchema = z.enum(["overall", "warranty", "trade"]);
const permissionLevelSchema = z.enum(["view", "edit"]);

const sectionKeySchema = z
  .string()
  .refine((value) => SPECIAL_ACCESS_SECTION_KEYS.includes(value), {
    message: "Unknown section key",
  });

const sectionsSchema = z.array(sectionKeySchema);
const regionsSchema = z.array(z.string().uuid("regionId must be a UUID"));

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(64)
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "Username can contain letters, digits, dot, underscore, and hyphen only",
  );

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(200);

const roleNameSchema = z.string().trim().min(1).max(80);

// --------------------------- access roles ---------------------------

export const createAccessRoleSchema = z.object({
  name: roleNameSchema,
  description: z.string().trim().max(300).nullable().optional(),
  defaultSections: sectionsSchema.default([]),
  defaultDataScope: dataScopeSchema.default("overall"),
  defaultPermissionLevel: permissionLevelSchema.default("view"),
});

export const updateAccessRoleSchema = z
  .object({
    name: roleNameSchema.optional(),
    description: z.string().trim().max(300).nullable().optional(),
    defaultSections: sectionsSchema.optional(),
    defaultDataScope: dataScopeSchema.optional(),
    defaultPermissionLevel: permissionLevelSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update",
  });

// --------------------------- special access ---------------------------

export const createSpecialAccessSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    roleId: z.string().uuid().nullable().optional(),
    sections: sectionsSchema.min(1, "Grant at least one section"),
    allRegions: z.boolean().default(false),
    regions: regionsSchema.default([]),
    dataScope: dataScopeSchema.default("overall"),
    permissionLevel: permissionLevelSchema.default("view"),
  })
  .superRefine((value, ctx) => {
    if (!value.allRegions && value.regions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["regions"],
        message: "Select at least one region, or grant all regions",
      });
    }
  });

export const updateSpecialAccessSchema = z
  .object({
    roleId: z.string().uuid().nullable().optional(),
    sections: sectionsSchema.min(1).optional(),
    allRegions: z.boolean().optional(),
    regions: regionsSchema.optional(),
    dataScope: dataScopeSchema.optional(),
    permissionLevel: permissionLevelSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update",
  });

export const resetSpecialAccessPasswordSchema = z.object({
  password: passwordSchema,
});

export const idParamSchema = z.object({
  id: z.string().uuid("id must be a UUID"),
});
