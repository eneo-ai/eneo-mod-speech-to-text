import type { AuthenticatedUser, AuthStatus } from "./api";

/**
 * Åtkomstkodsläget är en delad grind utan användaridentitet: backend svarar
 * `authenticated: true` men `user: null`. UI:t behöver ändå en identitet för
 * kontomenyn, så vi visar ett neutralt "Testläge" i stället för att neka.
 */
export const ACCESS_CODE_USER: AuthenticatedUser = {
  id: "access-code",
  email: "",
  username: "Testläge",
};

/** Identiteten för en autentiserad session, eller null när sessionen saknas. */
export function sessionUser(status: AuthStatus): AuthenticatedUser | null {
  if (!status.authenticated) return null;
  if (status.user) return status.user;
  return status.auth_mode === "access_code" ? ACCESS_CODE_USER : null;
}

export function userDisplayName(user: AuthenticatedUser): string {
  const username = user.username?.trim();
  return username || user.email.trim();
}

export function userInitial(user: AuthenticatedUser): string {
  const [firstCharacter] = Array.from(userDisplayName(user));
  return firstCharacter?.toLocaleUpperCase("sv-SE") || "?";
}
