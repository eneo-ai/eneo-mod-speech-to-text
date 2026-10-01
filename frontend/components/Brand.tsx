"use client";

import Link from "next/link";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TopNavHeading } from "@astryxdesign/core/TopNav";
import type { Branding } from "@/lib/api";

// Without a provider there is no organisation to name: the backend's branding (readBranding) is the one owner of who is shown.
const BrandingContext = createContext<Branding>({ organization: null });

/** The deployment's branding, read by the root layout from the module's backend for every page. */
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
 * choice of logo are the stylesheet's, by data-brand-logo (app/globals.css): default is Sundsvall's black mark, light
 * and dark are an organisation's two logos, plain one logo that serves both modes, name no logo at all.
 */
function OrganizationMark({ organization }: { organization: NonNullable<Branding["organization"]> }) {
  const { name, logo, dark_logo: darkLogo } = organization;
  if (logo === "default") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src="/brand/sundsvalls-kommun-logotyp.svg" alt={name} data-brand-logo="default" />;
  }
  if (logo === "custom") {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/api/branding/logo/light" alt={name} data-brand-logo={darkLogo ? "light" : "plain"} />
        {darkLogo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/api/branding/logo/dark" alt={name} data-brand-logo="dark" />
        )}
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
      as={Link}
      logo={mark}
      heading="Tal till text"
      headingHref={href}
      // A link says where it goes and for whom; a lockup that goes nowhere is just words.
      aria-label={href ? (organization ? `Tal till text – ${organization.name}` : "Tal till text") : undefined}
      onClickCapture={onClickCapture}
    />
  );
}
