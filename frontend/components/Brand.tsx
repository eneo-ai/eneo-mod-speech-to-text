"use client";

import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TopNavHeading } from "@astryxdesign/core/TopNav";
import { RouterLink } from "@/kit/RouterLink";
import type { Branding, Organization } from "@/lib/read-branding";

// Without a provider there is no organisation to name: the page's branding marker (readBranding) is the one owner of who is shown.
const BrandingContext = createContext<Branding>({ organization: null });

// The bundled mark's proportions: its viewBox (277.4 x 110.3), tenfold to whole numbers (lib/brand.test.ts reads the file).
const DEFAULT_LOGO = { src: "/brand/sundsvalls-kommun-logotyp.svg", width: 2774, height: 1103 };

/** The deployment's branding, read from the page once, before the first render (routes/Root.tsx). */
export function BrandingProvider({ value, children }: { value: Branding; children: ReactNode }) {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

interface BrandProps {
  /** Linka lockupen till denna sökväg. Utelämna för en statisk lockup (t.ex. inloggning). */
  href?: string;
  /** Asked before the link leaves the page; call preventDefault to stay. */
  onClickCapture?: ComponentProps<typeof TopNavHeading>["onClickCapture"];
}

/**
 * The organisation's mark: its logo (plain <img>, same-origin), or its name as text. Sizing and the colour mode's
 * choice of logo are the stylesheet's, by data-brand-logo (styles/globals.css): default is Sundsvall's black mark, light
 * and dark are an organisation's two logos, plain one logo that serves both modes, name no logo at all.
 */
function OrganizationMark({ organization }: { organization: Organization }) {
  const { name, logo, logo_sizes: sizes } = organization;
  // Every logo has its width and height, so the header keeps its shape before the file has arrived.
  if (logo === "default") {
    return <img src={DEFAULT_LOGO.src} alt={name} width={DEFAULT_LOGO.width} height={DEFAULT_LOGO.height} data-brand-logo="default" />;
  }
  if (logo === "custom" && sizes) {
    return (
      <>
        <img src="/api/branding/logo/light" alt={name} {...sizes.light} data-brand-logo={sizes.dark ? "light" : "plain"} />
        {sizes.dark && <img src="/api/branding/logo/dark" alt={name} {...sizes.dark} data-brand-logo="dark" />}
      </>
    );
  }
  return (
    <Text weight="semibold" data-brand-logo="name">
      {name}
    </Text>
  );
}

// Header-lockup: organisationens märke, avdelare och produktnamn; utan organisation bara produktnamnet.
export function Brand({ href, onClickCapture }: BrandProps) {
  const { organization } = useContext(BrandingContext);
  const mark = organization && (
    <HStack gap={4} vAlign="center">
      <OrganizationMark organization={organization} />
      {/* A vertical rule takes the height of a box that has one; it is decoration. */}
      <HStack height="2rem" aria-hidden>
        <Divider orientation="vertical" variant="strong" />
      </HStack>
    </HStack>
  );
  return (
    <TopNavHeading
      as={RouterLink}
      logo={mark}
      heading="Tal till text"
      headingHref={href}
      // A link says where it goes and for whom; a lockup that goes nowhere is just words.
      aria-label={href ? (organization ? `Tal till text – ${organization.name}` : "Tal till text") : undefined}
      onClickCapture={onClickCapture}
    />
  );
}
