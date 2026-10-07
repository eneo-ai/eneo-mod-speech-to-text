import type { AuthenticatedUser, AuthStatus } from "./api";

/** Identiteten för en autentiserad session, eller null när sessionen saknas. */
export function sessionUser(status: AuthStatus): AuthenticatedUser | null {
  return status.authenticated ? status.user : null;
}

export function userDisplayName(user: AuthenticatedUser): string {
  const username = user.username?.trim();
  return username || user.email.trim();
}
