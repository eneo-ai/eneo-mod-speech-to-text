"use client";

import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";
import type { Branding } from "@/lib/api";
import { cn } from "@/lib/utils";

const SUNDSVALL: Branding = { organization: { name: "Sundsvalls kommun", logo: "default", dark_logo: false } };

const BrandingContext = createContext<Branding>(SUNDSVALL);

/** The deployment's branding, read by the root layout from the module's backend for every page. */
export function BrandingProvider({ value, children }: { value: Branding; children: ReactNode }) {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

interface BrandProps {
  /** Linka lockupen till denna sökväg. Utelämna för en statisk lockup (t.ex. inloggning). */
  href?: string;
  className?: string;
}

// Another organisation's logo keeps Sundsvall's height; a wide one scales down inside a bounded width.
const LOGO = "block h-10 w-auto max-w-[6.5rem] object-contain object-left sm:max-w-[10rem]";

/** The organisation's mark: its logo (plain <img>, same-origin), or its name as text. */
function OrganizationMark({ organization }: { organization: NonNullable<Branding["organization"]> }) {
  const { name, logo, dark_logo: darkLogo } = organization;
  if (logo === "default") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src="/brand/sundsvalls-kommun-logotyp.svg" alt={name} className="block h-10 w-auto dark:invert" />;
  }
  if (logo === "custom") {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/api/branding/logo/light" alt={name} className={cn(LOGO, darkLogo && "dark:hidden")} />
        {darkLogo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/api/branding/logo/dark" alt={name} className={cn(LOGO, "hidden dark:block")} />
        )}
      </>
    );
  }
  return (
    <span className="block max-w-[6.5rem] text-[15px] font-semibold leading-tight text-ink sm:max-w-[12rem]">{name}</span>
  );
}

// Header-lockup: organisationens märke, avdelare och produktnamn; utan organisation bara produktnamnet.
export function Brand({ href, className }: BrandProps) {
  const { organization } = useContext(BrandingContext);
  const lockup = (
    <span className={`inline-flex items-center gap-6 ${className ?? ""}`}>
      {organization && (
        <>
          <OrganizationMark organization={organization} />
          <span aria-hidden className="block h-8 w-px shrink-0 bg-rule" />
        </>
      )}
      <span className="whitespace-nowrap text-[19px] font-bold leading-none">
        Tal till text
      </span>
    </span>
  );
  if (!href) return lockup;
  return (
    <Link
      href={href}
      aria-label={organization ? `Tal till text – ${organization.name}` : "Tal till text"}
      className="inline-flex items-center rounded-md [@media(pointer:coarse)]:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
    >
      {lockup}
    </Link>
  );
}
