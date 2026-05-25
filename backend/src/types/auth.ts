import type { UserRole } from "@opencall/shared";

export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string | null;
  role: UserRole;
  regionId: string | null;
  region_id: string | null;
  mustChangePassword: boolean;
}
