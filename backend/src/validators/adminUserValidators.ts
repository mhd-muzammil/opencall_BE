import { z } from "zod";

const userRoleSchema = z.enum(["SUPER_ADMIN", "REGION_ADMIN"]);
const trimmedString = (max = 200) => z.string().trim().min(1).max(max);
const emailSchema = trimmedString(200).email("Invalid email address");
const usernameSchema = trimmedString(80).regex(
  /^[a-zA-Z0-9._-]+$/,
  "Username can contain letters, digits, dot, underscore, and hyphen only",
);
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(200);

export const listUsersQuerySchema = z.object({
  role: userRoleSchema.optional(),
  regionId: z
    .string()
    .uuid("regionId must be a UUID")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  isActive: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((value) =>
      value === undefined ? undefined : value === "true",
    ),
  q: trimmedString(100).optional(),
});

// A section-access grant: null = all sections (the default), or a list of section keys
// that restricts a REGION_ADMIN. Keys are validated against USER_SECTION_KEYS server-side.
const accessibleSectionsSchema = z
  .array(z.string().trim().min(1))
  .nullable()
  .optional();

export const createUserSchema = z
  .object({
    email: emailSchema,
    username: usernameSchema.nullable().optional(),
    password: passwordSchema,
    role: userRoleSchema,
    regionId: z.string().uuid().nullable().optional(),
    mustChangePassword: z.boolean().optional(),
    accessibleSections: accessibleSectionsSchema,
  })
  .superRefine((value, ctx) => {
    if (value.role === "REGION_ADMIN" && !value.regionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["regionId"],
        message: "regionId is required for REGION_ADMIN",
      });
    }
    if (value.role === "SUPER_ADMIN" && value.regionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["regionId"],
        message: "SUPER_ADMIN cannot have a region",
      });
    }
  });

export const updateProfileSchema = z
  .object({
    email: emailSchema.optional(),
    username: usernameSchema.nullable().optional(),
  })
  .refine(
    (value) => value.email !== undefined || value.username !== undefined,
    { message: "Provide at least one field to update" },
  );

export const changeRoleSchema = z
  .object({
    role: userRoleSchema,
    regionId: z.string().uuid().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.role === "REGION_ADMIN" && !value.regionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["regionId"],
        message: "regionId is required for REGION_ADMIN",
      });
    }
    if (value.role === "SUPER_ADMIN" && value.regionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["regionId"],
        message: "SUPER_ADMIN cannot have a region",
      });
    }
  });

export const reassignRegionSchema = z.object({
  regionId: z.string().uuid().nullable(),
});

export const setUserRegionsSchema = z.object({
  regionIds: z.array(z.string().uuid("Each regionId must be a UUID")),
});

export const setUserSectionsSchema = z.object({
  // null = all sections; a list restricts a REGION_ADMIN to those keys.
  accessibleSections: z.array(z.string().trim().min(1)).nullable(),
});

export const passwordResetSchema = z.object({
  password: passwordSchema,
  requireChange: z.boolean().default(true),
});

export const selfPasswordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required").max(200),
  newPassword: passwordSchema,
});

export const userIdParamSchema = z.object({
  id: z.string().uuid("id must be a UUID"),
});
