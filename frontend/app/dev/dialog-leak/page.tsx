import { notFound } from "next/navigation";

// A development page for tests/e2e/leaks.spec.ts: the ways a confirmation dialog can be mounted, side by side.
// Never compiled into a production build.
export default async function DialogLeakPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  } else {
    const { DialogLeakFixture } = await import("./DialogLeakFixture");
    return <DialogLeakFixture />;
  }
}
