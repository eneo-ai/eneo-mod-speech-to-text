import type { AuthenticatedUser } from "./api";

export function userDisplayName(user: AuthenticatedUser): string {
  const username = user.username?.trim();
  return username || user.email.trim();
}

export function userInitial(user: AuthenticatedUser): string {
  const [firstCharacter] = Array.from(userDisplayName(user));
  return firstCharacter?.toLocaleUpperCase("sv-SE") || "?";
}
