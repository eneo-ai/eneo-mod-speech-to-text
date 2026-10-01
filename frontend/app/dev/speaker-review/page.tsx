import { notFound } from "next/navigation";

// A development page, gated like app/dev/foundation: FOUNDATION_CHECK=1 at build time also compiles it into a production
// build; without it the build has no code of this page. The import sits in the else branch so the bundler drops it when
// the condition is known at build time.
export default async function SpeakerReviewFixturesPage() {
  if (process.env.NODE_ENV !== "development" && process.env.FOUNDATION_CHECK !== "1") {
    notFound();
  } else {
    const { ReviewFixtures } = await import("./ReviewFixtures");
    return <ReviewFixtures />;
  }
}
