import type {
  UserRole,
  SpecialAccessDataScope,
  SpecialAccessPermissionLevel,
} from "@opencall/shared";

export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string | null;
  role: UserRole;
  regionId: string | null;
  region_id: string | null;
  mustChangePassword: boolean;
}

/**
 * A special-access principal — a standalone scoped login (row in `special_access`,
 * NOT in `users`). Resolved by `requirePrincipal` onto `request.specialAccess`. It is
 * deliberately a separate shape from `AuthenticatedUser` so it can never satisfy the
 * `requireAuthenticatedUser` / `requireRole` guards that protect admin + existing routes.
 */
export interface SpecialAccessPrincipal {
  id: string;
  username: string;
  roleId: string | null;
  roleName: string | null;
  sections: string[];
  allRegions: boolean;
  regions: string[];
  dataScope: SpecialAccessDataScope;
  permissionLevel: SpecialAccessPermissionLevel;
}
