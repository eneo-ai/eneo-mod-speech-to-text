// Copied in shape from eneo-module-kit-ui, template/web/src/main.tsx (RouterLink), commit 1559766, and made to tell a
// page of the app from a file.

import type { AnchorHTMLAttributes } from "react";
import { Link } from "react-router";

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href?: string;
  /** The design system hands a link `to` as well as `href`, for routers that read `to`; this one reads `href`. */
  to?: string;
};

/** A path of the app's own pages: not another origin (`//host`), not the API's, which answers files and not pages. */
function isPage(href: string | undefined): href is string {
  return !!href && href.startsWith("/") && !href.startsWith("//") && href !== "/api" && !href.startsWith("/api/");
}

/**
 * The link for every link the design system draws (`LinkProvider`, `as={RouterLink}`). A page of the app is a client
 * navigation, so opening it is not a page load. Everything else is the plain anchor it is: a fragment, `mailto:`,
 * another origin, a file of the API opened in a new tab or downloaded. A router link to `/api/…` would be a
 * navigation to a path the router has no page for.
 */
export function RouterLink({ to: _to, href, ...rest }: Props) {
  const ownTab = rest.target === undefined || rest.target === "_self";
  if (isPage(href) && ownTab && rest.download === undefined) return <Link to={href} {...rest} />;
  return <a href={href} {...rest} />;
}
