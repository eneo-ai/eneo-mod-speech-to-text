"use client";

import { useState } from "react";
import { Info, Loader2, RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { FlowRunPublic } from "@/lib/api";
import { regenerate, type RegenerationRequest } from "@/lib/regenerate";

/**
 * Says, without alarm, that the document was made from the transcript before
 * the saved corrections, and offers to make it again from the corrected one.
 * Nothing happens unless the user asks; the new run is followed like any other.
 */
export function RegenerateNotice({
  offer,
  saving,
  onStarted,
  onReload,
}: {
  offer: RegenerationRequest;
  /** Corrections are being saved; a new document waits for them. */
  saving: boolean;
  onStarted: (run: FlowRunPublic) => void;
  /** Reads the transcript and its corrections again, after they changed elsewhere. */
  onReload: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [refusal, setRefusal] = useState<{ message: string; reload: boolean } | null>(null);

  async function start() {
    setWorking(true);
    setRefusal(null);
    const outcome = await regenerate(offer);
    setWorking(false);
    if (outcome.kind === "started") onStarted(outcome.run);
    else setRefusal(outcome);
  }

  return (
    // A note, not an alarm: it is there when the page opens and needs no announcement.
    <Alert role="note">
      <Info aria-hidden />
      <AlertTitle>Dokumentet skapades före dina rättningar</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <p>Den nya versionen görs från det rättade transkriptet.</p>
        <Button type="button" variant="outline" className="h-auto min-h-9 whitespace-normal py-2 text-left coarse:min-h-11" disabled={working || saving} onClick={() => void start()}>
          {working ? <Loader2 data-icon="inline-start" aria-hidden className="animate-spin motion-reduce:animate-none" /> : <RotateCcw data-icon="inline-start" aria-hidden />}
          {working ? "Skapar dokumentet igen…" : saving ? "Sparar rättningarna…" : "Skapa dokumentet igen med rättningarna"}
        </Button>
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
