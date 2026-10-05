import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useMatches, useNavigationType, type NavigationType } from "react-router";
import { useAnnounce } from "@astryxdesign/core/hooks";

/** What a route says about itself beside its page: the title, which the page itself may refine. */
export interface RouteHandle {
  title: string;
}

/** The navigation the person has made, until its page has its content and what follows it has been done. */
interface Navigation {
  path: string;
  /** The history entry's own key, under which its scroll offset is kept. */
  key: string;
  type: NavigationType;
  /** Its page has not yet had what follows a navigation done for it: the scroll offsets of the entry are not touched. */
  waiting: boolean;
  /** Its page has said it has its content, and the rest is set for the next frame. */
  scheduled: boolean;
}

/** The one RouteEffects that is mounted, to which a page says it has its content. */
let pageIsReady: ((path: string) => void) | null = null;

/**
 * A page says it has its first real content (the list answered, the flow loaded, the sign-in is no longer asking), not
 * a spinner. A page behind AuthGate is a spinner until the session has answered, and the gate then replaces the whole
 * shell: the page, not the router, knows when it is there.
 */
export function useRouteReady(ready: boolean) {
  const { pathname } = useLocation();
  useEffect(() => {
    if (ready) pageIsReady?.(pathname);
  }, [ready, pathname]);
}

/**
 * What a navigation gives the person (WCAG 2.4.2, 2.4.3, 4.1.3). At once, the route's title. When the page says it has
 * its content (`useRouteReady`), in the next frame (a focus the page took itself in its own effects has happened by
 * then), once: its title said through the live region, the focus on its heading if the navigation left it nowhere and
 * the person has done nothing since, and the scroll, to the top for a link and to the entry's own offset for Back. Only a new path is a
 * navigation: a page that writes `?run=` into the address changes its own state. The first load, and the redirect the
 * first page sends the person on by before any page has its content, do none of it. This is the one place that
 * scrolls after a navigation.
 */
export function RouteEffects() {
  const { pathname, key } = useLocation();
  const type = useNavigationType();
  const matches = useMatches();
  const announce = useAnnounce();
  const title = [...matches].reverse().map((match) => (match.handle as RouteHandle | undefined)?.title).find(Boolean);
  const navigation = useRef<Navigation>({ path: pathname, key, type, waiting: false, scheduled: false });
  const loaded = useRef(false);
  const offsets = useRef(new Map<string, number>());
  // The person pressed a key or the pointer since the page changed: what they did decides where the focus is.
  const acted = useRef(false);

  // A layout effect, so the route's title is set before the new page's own effects, which name it more closely
  // (`useDocumentTitle`) and so have the last word. A route without a title leaves the title as it was.
  useLayoutEffect(() => {
    if (title) document.title = title;
    if (navigation.current.path === pathname) return;
    navigation.current = { path: pathname, key, type, waiting: loaded.current || type !== "REPLACE", scheduled: false };
    acted.current = false;
    // Only a new path retitles and waits; the title follows the path the matches belong to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useLayoutEffect(() => {
    const settle = (arrived: Navigation) => {
      announce(document.title);
      if (!acted.current) moveFocusToHeading();
      const top = arrived.type === "POP" ? (offsets.current.get(arrived.key) ?? 0) : 0;
      window.scrollTo({ left: 0, top, behavior: "instant" });
      arrived.waiting = false;
    };
    pageIsReady = (path) => {
      const arrived = navigation.current;
      if (arrived.path !== path) return;
      loaded.current = true;
      if (!arrived.waiting || arrived.scheduled) return;
      arrived.scheduled = true;
      requestAnimationFrame(() => settle(arrived));
    };
    return () => {
      pageIsReady = null;
    };
  }, [announce]);

  useEffect(() => {
    const note = () => {
      acted.current = true;
    };
    document.addEventListener("keydown", note, true);
    document.addEventListener("pointerdown", note, true);
    return () => {
      document.removeEventListener("keydown", note, true);
      document.removeEventListener("pointerdown", note, true);
    };
  }, []);

  // Where each entry is scrolled to, for Back. Not while an entry is waiting for its page: a page that is shorter
  // than it was moves the window itself, and that is not where the person left the entry.
  useEffect(() => {
    const remember = () => {
      const current = navigation.current;
      if (!current.waiting) offsets.current.set(current.key, Math.round(window.scrollY));
    };
    window.addEventListener("scroll", remember, { passive: true });
    return () => window.removeEventListener("scroll", remember);
  }, []);

  return null;
}

/**
 * The page's heading takes the focus when it is nowhere (the control that had it left with the old page): a phase's
 * heading (`data-phase-heading`), else a heading made focusable for it, else the first one. Focus that is on any
 * element, the page's own or the person's, stays. It scrolls nothing: the scroll is the navigation's own.
 */
function moveFocusToHeading() {
  const main = document.querySelector<HTMLElement>('main, [role="main"]');
  if (document.activeElement && document.activeElement !== document.body) return;
  const heading = main?.querySelector<HTMLElement>("[data-phase-heading], h1[tabindex]") ?? main?.querySelector<HTMLElement>("h1");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}
