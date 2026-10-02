import { useLayoutEffect } from "react";
import { useLocation, useMatches } from "react-router";

/** What a route says about itself beside its page: the title, which the page itself may refine. */
export interface RouteHandle {
  title: string;
}

/**
 * What happens when the person has moved to another page. Now: the title is the route's, at once (Next did this from
 * `metadata`); WCAG 2.4.2. Only a change of the path counts: a page that writes `?run=` into the address keeps the title
 * it has set. A layout effect, so the route's title is set before the new page's own effects, which name it more
 * closely (`useDocumentTitle`) and so have the last word. A route without a title leaves the title as it was.
 */
export function RouteEffects() {
  const { pathname } = useLocation();
  const matches = useMatches();
  const title = [...matches].reverse().map((match) => (match.handle as RouteHandle | undefined)?.title).find(Boolean);
  useLayoutEffect(() => {
    if (title) document.title = title;
    // Only a new path retitles; the title follows the path the matches belong to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  return null;
}
