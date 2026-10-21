import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Divider } from "@astryxdesign/core/Divider";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TopNavHeading } from "@astryxdesign/core/TopNav";
import { RouterLink } from "@/kit/RouterLink";
import type { Branding, Organization } from "@/lib/read-branding";
import { PRODUCT_NAME } from "@/lib/product";

// Without a provider there is no organisation to name: the page's branding marker (readBranding) is the one owner of who is shown.
const BrandingContext = createContext<Branding>({ organization: null });

// Eneo's wordmark, the bundled default, for each colour mode: its viewBox's proportions (lib/brand.test.ts reads the file).
const DEFAULT_LOGO = { light: "/brand/eneo-logotyp.svg", dark: "/brand/eneo-logotyp-mork.svg", width: 650, height: 172 };

/** The deployment's branding, read from the page once, before the first render (routes/Root.tsx). */
export function BrandingProvider({ value, children }: { value: Branding; children: ReactNode }) {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

/** The organisation a deployment has set for itself, or null where it shows Eneo's own (the default) or none. */
export function useOwnOrganization(): Organization | null {
  const { organization } = useContext(BrandingContext);
  return organization && organization.logo !== "default" ? organization : null;
}

interface BrandProps {
  /** Links the lockup to this path. Left out, the lockup is static (the sign-in page). */
  href?: string;
}

/**
 * The organisation's mark: its logo (plain <img>, same-origin), or its name as text. Sizing and the colour mode's
 * choice of logo are the stylesheet's, by data-brand-logo (styles/globals.css): light and dark are a pair of logos (Eneo's
 * own wordmark by default, or an organisation's two), plain one logo that serves both modes, name no logo at all.
 */
function OrganizationMark({ organization }: { organization: Organization }) {
  const { name, logo, logo_sizes: sizes } = organization;
  // Every logo has its width and height, so the header keeps its shape before the file has arrived.
  if (logo === "default") {
    const size = { width: DEFAULT_LOGO.width, height: DEFAULT_LOGO.height };
    return (
      <>
        <img src={DEFAULT_LOGO.light} alt={name} {...size} data-brand-logo="light" data-wordmark="" />
        <img src={DEFAULT_LOGO.dark} alt={name} {...size} data-brand-logo="dark" data-wordmark="" />
      </>
    );
  }
  if (logo === "custom" && sizes) {
    // A near-square mark (under 3:2) is set a step lower (styles/globals.css).
    const compact = (size: { width: number; height: number }) => (size.width < 1.5 * size.height ? "" : undefined);
    return (
      <>
        <img src="/api/branding/logo/light" alt={name} {...sizes.light} data-brand-logo={sizes.dark ? "light" : "plain"} data-compact={compact(sizes.light)} />
        {sizes.dark && <img src="/api/branding/logo/dark" alt={name} {...sizes.dark} data-brand-logo="dark" data-compact={compact(sizes.dark)} />}
      </>
    );
  }
  // A name a step smaller than the product's: on one line below 640 px, where the lockup leaves it out when the bar has
  // no room for it (useRoomForName), and in two lines at most from there (styles/globals.css). The link's name and the
  // sign-in's line under its card say it whole.
  return (
    <Text weight="semibold" size="sm" maxLines={2} hasTruncateTooltip={false} data-brand-logo="name">
      {name}
    </Text>
  );
}

/**
 * Whether a name without a logo has room in the bar: the bar's start, measured with the name in it before the first
 * paint, against the room the account leaves it. Measured again whenever the bar or the lockup changes size (a phone
 * turned, the reader's text spacing); a name left out by the width it took when it last stood in the bar. A font still
 * on its way when the name was measured changes that width: once it has arrived the name is put back and measured
 * again, before the next paint. `ref` goes on the lockup.
 */
function useRoomForName() {
  const [lockup, ref] = useState<HTMLElement | null>(null);
  const [fits, setFits] = useState(true);
  const needs = useRef(0);
  useLayoutEffect(() => {
    const start = lockup?.closest(".astryx-top-nav > *");
    if (!lockup || !start) return;
    let live = true;
    const measure = () => {
      if (fits) needs.current = start.scrollWidth;
      setFits(needs.current <= start.clientWidth);
    };
    measure();
    // Once a font that was on its way has arrived, the name is measured as if it had never been left out.
    if (document.fonts?.status === "loading") {
      void document.fonts.ready.then(() => {
        if (!live) return;
        needs.current = 0;
        measure();
      });
    }
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(start);
    observer?.observe(lockup);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [lockup, fits]);
  return { ref, fits };
}

// The header lockup: the organisation's mark, a divider and the product name; without an organisation the product name alone.
export function Brand({ href }: BrandProps) {
  const { organization } = useContext(BrandingContext);
  // A logo always stands in the bar; a name without one only where it fits on the bar's one line, its divider with it.
  const room = useRoomForName();
  // On the narrowest phones the mark is smaller (styles/globals.css) and stands closer to its divider: the product name
  // and the account button then keep their room with a wide font and the reader's text spacing.
  const narrowest = useMediaQuery("(max-width: 359px)");
  const mark = organization && (
    <HStack gap={narrowest ? 2 : 4} vAlign="center">
      <OrganizationMark organization={organization} />
      {/* A vertical rule takes the height of a box that has one; it is decoration. */}
      <HStack height="2rem" aria-hidden>
        <Divider orientation="vertical" variant="strong" />
      </HStack>
    </HStack>
  );
  return (
    <TopNavHeading
      ref={organization?.logo === null ? room.ref : undefined}
      as={RouterLink}
      logo={room.fits && mark}
      heading={PRODUCT_NAME}
      headingHref={href}
      // A link says where it goes and for whom; a lockup that goes nowhere is just words.
      aria-label={href ? (organization ? `${PRODUCT_NAME} – ${organization.name}` : PRODUCT_NAME) : undefined}
    />
  );
}
