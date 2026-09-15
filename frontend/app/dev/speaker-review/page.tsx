import { notFound } from "next/navigation";
import { ReviewFixtures } from "./ReviewFixtures";
export default function SpeakerReviewFixturesPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <ReviewFixtures />;
}
