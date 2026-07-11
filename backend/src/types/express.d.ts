import type { AuthenticatedUser, SpecialAccessPrincipal } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      currentUser?: AuthenticatedUser;
      specialAccess?: SpecialAccessPrincipal;
    }
  }
}

export {};
