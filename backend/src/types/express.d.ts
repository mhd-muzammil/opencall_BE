import type {
  AuthenticatedUser,
  SpecialAccessPrincipal,
  VendorAccessPrincipal,
} from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      currentUser?: AuthenticatedUser;
      specialAccess?: SpecialAccessPrincipal;
      vendorAccess?: VendorAccessPrincipal;
    }
  }
}

export {};
