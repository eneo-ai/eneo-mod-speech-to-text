"use client";

import { useState } from "react";
import { Info, Loader2, RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { CorrectionsSaveState } from "@/components/TranscriptPlayer";
import type { FlowRunPublic } from "@/lib/api";
import { regenerate, type RegenerationRequest } from "@/lib/regenerate";

/**
 * Says, without alarm, that the document was made from the transcript before
 * the saved corrections, and offers to make it again from the corrected one.
 * Nothing happens unless the user asks; the new run is followed like any other.
 */
export function RegenerateNotice({
  offer,
  saveState,
  onStarted,
  onReload,
  thing = "dokumentet",
}: {
  offer: RegenerationRequest;
  /** The transcript's latest save: a new document waits while one runs, and after one failed. */
  saveState: CorrectionsSaveState;
  onStarted: (run: FlowRunPublic) => void;
  /** Reads the transcript and its corrections again, after they changed elsewhere. */
  onReload: () => void;
  /** What the run makes, as the notice names it: "dokumentet", "texten" or "resultatet" (`outputWords`). */
  thing?: string;
}) {
  const [working, setWorking] = useState(false);
  const [refusal, setRefusal] = useState<{ message: string; reload: boolean } | null>(null);
  const saving = saveState === "saving";
  const unsaved = saveState === "error";

  async function start() {
    setWorking(true);
    setRefusal(null);
    const outcome = await regenerate(offer, thing);
    setWorking(false);
    if (outcome.kind === "started") onStarted(outcome.run);
    else setRefusal(outcome);
  }

  return (
    // A note, not an alarm: it is there when the page opens and needs no announcement.
    <Alert role="note">
      <Info aria-hidden />
      <AlertTitle>{thing[0].toUpperCase() + thing.slice(1)} skapades före dina rättningar</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <p>Den nya versionen görs från det rättade transkriptet.</p>
        <Button type="button" variant="outline" className="h-auto min-h-9 whitespace-normal py-2 text-left coarse:min-h-11" disabled={working || saving || unsaved} onClick={() => void start()}>
          {working ? <Loader2 data-icon="inline-start" aria-hidden className="animate-spin motion-reduce:animate-none" /> : <RotateCcw data-icon="inline-start" aria-hidden />}
          {working ? `Skapar ${thing} igen…` : saving ? "Sparar rättningarna…" : `Skapa ${thing} igen med rättningarna`}
        </Button>
        {unsaved && (
          <p className="text-muted-foreground">
            Den senaste rättningen är inte sparad. Spara den igen i transkriptet innan {thing} skapas på nytt.
          </p>
        )}
        {refusal && (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-destructive">{refusal.message}</p>
            {refusal.reload && (
              <Button type="button" variant="ghost" size="sm" onClick={onReload}>
                Läs in igen
              </Button>
            )}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
