import type { Branding } from "./api";

/** How long the page waits for the optional branding before it shows the product name alone. */
export const BRANDING_DEADLINE_MS = 2_000;

/**
 * The deployment's branding from the module's backend; without a timely answer, the product name alone.
 * It is optional, so a backend that stalls must not hold the page: the whole read has one deadline.
 */
export async function readBranding(
  base: string,
  fetchImpl: typeof fetch = fetch,
  deadlineMs: number = BRANDING_DEADLINE_MS,
): Promise<Branding> {
  try {
    const response = await fetchImpl(`${base}/api/branding`, {
      cache: "no-store",
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (response.ok) return (await response.json()) as Branding;
    console.error(`GET /api/branding answered ${response.status}; the header shows "Tal till text" alone.`);
  } catch (error) {
    console.error(`GET /api/branding failed (${String(error)}); the header shows "Tal till text" alone.`);
  }
  return { organization: null };
}
