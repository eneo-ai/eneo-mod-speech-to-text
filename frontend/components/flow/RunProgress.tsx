"use client";

import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { BackToFlows } from "@/components/flow/BackToFlows";
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
import { STATE_HEADING, StateCard } from "./StateCard";
import { usePhaseHeading } from "./usePhaseHeading";

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
    <StateCard>
      <div className="flex flex-col gap-2">
        <h1
          ref={heading}
          tabIndex={-1}
          className={STATE_HEADING}
        >
          Dokumentet skapas
        </h1>
        <p role="status" className="flex items-center gap-2 text-base">
          <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
          {stage}
        </p>
      </div>
      {steps.length > 0 && (
        <section aria-label="Flödets steg">
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
    </StateCard>
  );
}

/** Opening an earlier run: the shape of the view until its state is known. */
export function RunOpening() {
  return (
    <StateCard aria-busy="true">
      <p role="status" className="sr-only">
        Hämtar körningen…
      </p>
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </StateCard>
  );
}

/** The run has ended but its result could not be read: say so, and read it again. */
export function RunUnread({ message, onRetry }: { message: string; onRetry: () => void }) {
  const heading = usePhaseHeading("Resultatet kunde inte hämtas");
  return (
    <StateCard>
      <div className="flex flex-col gap-2">
        <h1 ref={heading} tabIndex={-1} className={STATE_HEADING}>
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
        <BackToFlows variant="outline" size="default" />
      </div>
    </StateCard>
  );
}
