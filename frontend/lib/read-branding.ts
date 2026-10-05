/**
 * The page's reader of the branding's shape, and how it learns it: the backend writes the answer of
 * `GET /api/branding` into `<meta name="eneo-branding">` when it starts (and the dev server does the same for each
 * page, lib/branding-marker.ts), so the organisation's mark is in the first frame and there is nothing to fetch.
 */

import { isRecord } from "./is-record";

/** A logo's proportions (a width and a height in whole numbers): the <img> keeps its room before the file arrives. */
interface LogoSize {
  width: number;
  height: number;
}

/**
 * The organisation beside "Tal till text": the bundled default logo ("default"), the deployment's own ("custom", with a
 * size for each of its files, and a dark one when `dark_logo`), or the name as text (null).
 */
export interface Organization {
  name: string;
  logo: "default" | "custom" | null;
  dark_logo: boolean;
  logo_sizes: { light: LogoSize; dark: LogoSize | null } | null;
}

/** No organisation shows the product name alone. */
export interface Branding {
  organization: Organization | null;
}

const isSize = (value: unknown): value is LogoSize =>
  isRecord(value) && Number.isInteger(value.width) && (value.width as number) > 0 && Number.isInteger(value.height) && (value.height as number) > 0;

/** The organisation a branding names, or an Error that says what is wrong with it. */
function parseOrganization(value: unknown): Organization {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "" || typeof value.dark_logo !== "boolean") {
    throw new Error("an organization needs a name and dark_logo");
  }
  const { name, logo, dark_logo: darkLogo, logo_sizes: sizes } = value;
  if (logo === "custom") {
    if (!isRecord(sizes) || !isSize(sizes.light) || !(sizes.dark === null || isSize(sizes.dark)) || (sizes.dark !== null) !== darkLogo) {
      throw new Error("a custom logo has a size, and its dark logo has one exactly when there is a dark logo");
    }
    return { name, logo, dark_logo: darkLogo, logo_sizes: { light: sizes.light, dark: sizes.dark } };
  }
  if (logo !== null && logo !== "default") throw new Error(`unknown logo ${JSON.stringify(logo)}`);
  if (sizes !== null || darkLogo) throw new Error("only a custom logo has a size or a dark logo");
  return { name, logo, dark_logo: false, logo_sizes: null };
}

/**
 * Who the deployment is for, from the page itself and at once: it is read before the first render. A marker that is
 * missing, empty or not the answer is a fault of the deployment, said once; the page then shows the product name alone,
 * never another organisation's mark.
 */
export function readBranding(root: ParentNode = document): Branding {
  try {
    const content = root.querySelector('meta[name="eneo-branding"]')?.getAttribute("content");
    if (!content) throw new Error(content === undefined ? "the page has no marker" : "nothing wrote the organisation into the marker");
    const answer: unknown = JSON.parse(content);
    if (!isRecord(answer) || !("organization" in answer)) throw new Error("the content is not a branding answer");
    return { organization: answer.organization === null ? null : parseOrganization(answer.organization) };
  } catch (error) {
    console.error(`<meta name="eneo-branding"> is unusable (${error instanceof Error ? error.message : String(error)}); the header shows "Tal till text" alone.`);
    return { organization: null };
  }
}
