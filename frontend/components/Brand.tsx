import Link from "next/link";

interface BrandProps {
  /** Linka lockupen till denna sökväg. Utelämna för en statisk lockup (t.ex. inloggning). */
  href?: string;
  className?: string;
}

// Lokal header-lockup: Sundsvalls kommuns logotyp, avdelare och produktnamn.
// Plain <img> är medvetet: en lokal SVG behöver ingen next/image-optimering.
export function Brand({ href, className }: BrandProps) {
  const lockup = (
    <span className={`inline-flex items-center gap-6 ${className ?? ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/sundsvalls-kommun-logotyp.svg"
        alt="Sundsvalls kommun"
        className="block h-10 w-auto dark:invert"
      />
      <span aria-hidden className="block h-8 w-px shrink-0 bg-rule" />
      <span className="whitespace-nowrap text-[19px] font-bold leading-none">
        Flöden
      </span>
    </span>
  );
  if (!href) return lockup;
  return (
    <Link
      href={href}
      aria-label="Flöden – Sundsvalls kommun"
      className="inline-flex rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
    >
      {lockup}
    </Link>
  );
}
