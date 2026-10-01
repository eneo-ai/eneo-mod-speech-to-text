import { notFound } from "next/navigation";

// A development page, for the accessibility gate and for looking at the speaker review. A production build has no code
// of it: the import sits in the else branch, so the bundler drops it when the condition is known at build time.
export default async function SpeakerReviewFixturesPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  } else {
    const { ReviewFixtures } = await import("./ReviewFixtures");
    return <ReviewFixtures />;
  }
}
