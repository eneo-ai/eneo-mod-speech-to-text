import { notFound } from "next/navigation";

// A development page. FOUNDATION_CHECK=1 at build time also compiles it into a production build, for tests/prod: a
// production build without it has no code of this page (its mere presence moved shared chunks and cost /flows ~3.6 KB).
// The import sits in the else branch so the bundler drops it when the condition is known at build time.
export default async function FoundationCheckPage() {
  if (process.env.NODE_ENV !== "development" && process.env.FOUNDATION_CHECK !== "1") {
    notFound();
  } else {
    const { FoundationCheck } = await import("./FoundationCheck");
    return <FoundationCheck />;
  }
}
