"use client";

import { Button } from "@/components/ui/button";

// The status regions are always rendered, so the sentences are announced when they appear.

/** The microphone went away mid-recording; what was recorded is kept. */
export function RecordingInterrupted({
  interrupted,
  onContinue,
}: {
  interrupted: boolean;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p role="status" className={interrupted ? "mt-4 text-[14px] text-ink" : "sr-only"}>
        {interrupted ? "Inspelningen pausades. Det som spelats in är sparat." : ""}
      </p>
      {interrupted && (
        <Button type="button" className="h-11" onClick={onContinue}>
          Fortsätt spela in
        </Button>
      )}
    </div>
  );
}

/** Where the recording lives, when that is worth saying. */
export function RecordingStorageNotice({
  persistent,
  lowSpace,
}: {
  persistent: boolean;
  lowSpace: boolean;
}) {
  return (
    <div role="status" className="space-y-1 text-center text-[12px] text-ink-soft">
      {!persistent && (
        <p className="mt-3">
          Inspelningen sparas bara i den här fliken. Stäng inte fliken innan den är skickad.
        </p>
      )}
      {lowSpace && (
        <p className="mt-3">
          Det finns lite lagringsutrymme kvar på enheten. Frigör utrymme om du ska spela in länge.
        </p>
      )}
    </div>
  );
}
