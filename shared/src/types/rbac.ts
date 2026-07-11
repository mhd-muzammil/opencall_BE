export type UserRole = "SUPER_ADMIN" | "REGION_ADMIN";

/**
 * Special-access credentials are NOT rows in `users`; they are standalone scoped
 * logins (see the `special_access` table). These types describe the extra scoping
 * dimensions a SUPER_ADMIN grants per credential. Kept separate from `UserRole` so
 * none of the existing 2-role logic (requireRole, validators, audit) is affected.
 */
export type SpecialAccessDataScope = "overall" | "warranty" | "trade";

export type SpecialAccessPermissionLevel = "view" | "edit";
