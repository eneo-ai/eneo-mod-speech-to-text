import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The launch environment Playwright's Firefox needs on a Mac. It reads its profile store under
 * ~/Library/Application Support/Firefox, which macOS keeps from apps that do not own it (the installed Firefox does), and
 * then stops with "Could not find profile folder". Given a home of its own for Application Support (CFFIXED_USER_HOME), it
 * starts. Elsewhere it needs nothing. Playwright's `env` replaces the browser's whole environment, so it is passed whole.
 */
export function firefoxEnv(): { env?: Record<string, string> } {
  if (process.platform !== "darwin") return {};
  const home = join(tmpdir(), "playwright-firefox-home");
  mkdirSync(home, { recursive: true });
  const inherited = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return { env: { ...Object.fromEntries(inherited), CFFIXED_USER_HOME: home } };
}
