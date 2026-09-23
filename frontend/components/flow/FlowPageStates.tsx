"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FlowTopBar } from "@/components/flow/FlowTopBar";
import { ApiError } from "@/lib/api";
import { friendlyError } from "@/lib/errors";

/** The flow page's shape while it loads, so nothing moves when it arrives. */
export function FlowSkeleton() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true">
      <p role="status" className="sr-only">
        Laddar flödet…
      </p>
      <div className="flex items-center gap-3 px-4 pb-1 pt-3 lg:hidden">
        <Skeleton className="size-9 rounded-full" />
        <Skeleton className="h-5 flex-1" />
        <Skeleton className="size-10 rounded-full" />
      </div>
      <div className="hidden h-16 border-b border-rule-soft bg-paper lg:block" />
      <div className="w-full flex-1 px-4 pb-12 pt-3 md:px-8 lg:grid lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start lg:gap-10 lg:pt-8">
        <div className="flex flex-col gap-5">
          <Skeleton className="hidden h-7 w-3/4 lg:block" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
        <div className="mt-10 flex flex-col gap-3 lg:mt-0">
          <Skeleton className="mb-1 h-6 w-56" />
          {[0, 1, 2].map((card) => (
            <Skeleton key={card} className="h-[4.75rem] w-full rounded-xl" />
          ))}
          <Skeleton className="mt-3 h-12 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

/** The flow could not be loaded: unpublished (404) or another failure, with a way on. */
export function FlowUnavailable({ error }: { error: unknown }) {
  const gone = error instanceof ApiError && (error.status === 404 || error.code === "flow_not_published");
  const title = gone ? "Flödet är inte längre tillgängligt." : "Flödet kunde inte laddas.";
  const detail = gone
    ? "Det kan ha avpublicerats eller tagits bort. Välj ett annat flöde."
    : `${friendlyError(error)} Försök igen om en stund.`;
  return (
    <div className="flex min-h-dvh flex-col">
      <FlowTopBar title={title} />
      <main id="innehall" className="w-full flex-1 px-4 pb-12 pt-3 md:px-8 lg:pt-10">
        <div className="flex max-w-xl flex-col gap-4">
          <h1 className="hidden text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink lg:block">
            {title}
          </h1>
          <p className="text-[17px] leading-relaxed text-ink-soft">{detail}</p>
          <div className="flex flex-wrap gap-3">
            <Button asChild className="h-11">
              <Link href="/flows">
                <ArrowLeft data-icon="inline-start" aria-hidden />
                Till flödena
              </Link>
            </Button>
            {!gone && (
              <Button type="button" variant="outline" className="h-11" onClick={() => window.location.reload()}>
                Försök igen
              </Button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
