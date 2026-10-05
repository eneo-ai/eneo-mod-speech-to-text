/** What the module is called, wherever it names itself: a landmark's name, the brand, a heading, a page's title. */
export const PRODUCT_NAME = "Tal till text";

/** The title of a page: what it is, then the module's name; the name alone for a page that has no title of its own. */
export function documentTitle(page?: string): string {
  return page ? `${page} · ${PRODUCT_NAME}` : PRODUCT_NAME;
}
