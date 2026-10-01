import { notFound } from "next/navigation";
import { FoundationCheck } from "./FoundationCheck";

// A development page; FOUNDATION_CHECK=1 also serves it from a production build, for tests/prod.
export default function FoundationCheckPage() {
  if (process.env.NODE_ENV !== "development" && process.env.FOUNDATION_CHECK !== "1") notFound();
  return <FoundationCheck />;
}
