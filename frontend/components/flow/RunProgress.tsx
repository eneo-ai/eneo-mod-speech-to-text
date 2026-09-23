"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, RotateCcw } from "lucide-react";
import { OfflineBanner } from "@/components/OfflineBanner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { StepView } from "@/lib/run-progress";
import { StepList } from "./StepList";
import { PHASE_HEADING, usePhaseHeading } from "./usePhaseHeading";

const VIEW = "mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 pb-10 pt-2 md:px-8";

/** The run goes on in Eneo: what happens now, every step, and a way to stop it. */
export function RunProgress({
  steps,
  stage,
  error = null,
  onCancel,
}: {
  steps: readonly StepView[];
  stage: string;
  error?: string | null;
  onCancel: () => Promise<void>;
}) {
  const heading = usePhaseHeading("Skapar dokument");
  const [cancelling, setCancelling] = useState(false);

  async function cancel() {
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  }

  return (
    <main className={VIEW}>
      <OfflineBanner waiting="run" />
      <div className="flex flex-col gap-2">
        <h1
          ref={heading}
          tabIndex={-1}
          className={PHASE_HEADING}
        >
          Dokumentet skapas
        </h1>
        <p role="status" className="flex items-center gap-2 text-base">
          <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
          {stage}
        </p>
      </div>
      {steps.length > 0 && (
        <section aria-label="Flödets steg" className="rounded-xl border bg-card p-4 md:p-6">
          <StepList steps={steps} />
        </section>
      )}
      <p className="text-sm text-muted-foreground">
        Du kan stänga sidan. Körningen fortsätter och resultatet finns kvar här.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" className="self-start" disabled={cancelling}>
            {cancelling && <Spinner data-icon="inline-start" aria-hidden />}
            Avbryt körningen
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Avbryta körningen?</AlertDialogTitle>
            <AlertDialogDescription>Flödet slutar arbeta och inget dokument skapas.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Kör vidare</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={() => void cancel()}>
              Avbryt körningen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

/** Opening an earlier run: the shape of the view until its state is known. */
export function RunOpening() {
  return (
    <main aria-busy="true" className={VIEW}>
      <p role="status" className="sr-only">
        Hämtar körningen…
      </p>
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </main>
  );
}

/** The run has ended but its result could not be read: say so, and read it again. */
export function RunUnread({ message, onRetry }: { message: string; onRetry: () => void }) {
  const heading = usePhaseHeading("Resultatet kunde inte hämtas");
  return (
    <main className={VIEW}>
      <div className="flex flex-col gap-2">
        <h1 ref={heading} tabIndex={-1} className={PHASE_HEADING}>
          Resultatet kunde inte hämtas
        </h1>
        <p className="text-base">{message}</p>
        <p className="text-sm text-muted-foreground">Körningen är avslutad och finns kvar i Eneo.</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={onRetry}>
          <RotateCcw data-icon="inline-start" aria-hidden />
          Försök igen
        </Button>
        <Button asChild variant="outline">
          <Link href="/flows">
            <ArrowLeft data-icon="inline-start" aria-hidden />
            Till flödena
          </Link>
        </Button>
      </div>
    </main>
  );
}
