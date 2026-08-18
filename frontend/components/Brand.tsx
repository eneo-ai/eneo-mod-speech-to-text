import Link from "next/link";

interface BrandProps {
  /** Linka lockupen till denna sökväg. Utelämna för en statisk lockup (t.ex. inloggning). */
  href?: string;
  className?: string;
}

// Header-lockup enligt samma mönster som Verktygslådan: Sundsvalls kommuns
// officiella logotyp (hela ordbilden, lokal SVG) · vertikal avdelare ·
// produktnamnet "Flöden".
//
// Måtten speglar Verktygslådan (som kör html font-size 62.5%, dvs 1rem=10px),
// översatta till absoluta px eftersom denna app kör 16px-bas:
//   logo 4rem→40px, avdelare 3.2rem→32px, produkt 1.9rem→19px, gap 2.4rem→24px.
// Produktnamnet sätts i header-typsnittet (Raleway) som i designsystemet.
// Plain <img> är medvetet: en lokal SVG behöver ingen next/image-optimering.
export function Brand({ href, className }: BrandProps) {
  const lockup = (
    <span className={`inline-flex items-center gap-6 ${className ?? ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/sundsvalls-kommun-logotyp.svg"
        alt="Sundsvalls kommun"
        className="block h-10 w-auto"
      />
      <span aria-hidden className="block h-8 w-px shrink-0 bg-rule" />
      <span
        className="whitespace-nowrap text-[19px] font-bold leading-none"
        style={{
          fontFamily: 'var(--sk-fontFamily-header), "Raleway", sans-serif',
        }}
      >
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
