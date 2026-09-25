"use client";

import { useEffect, useState } from "react";
import type { FlowRunStep } from "@/lib/api";
import { INITIAL_TRANSCRIPT, loadTranscriptContext, type TranscriptContext } from "@/lib/transcript-context";

/** The transcript context for a run (see loadTranscriptContext), read again by `reload`. */
export function useTranscriptContext({
  flowId,
  runId,
  enabled,
  steps,
  source,
  fallbackText,
  labelFor,
}: {
  flowId: string;
  runId: string;
  enabled: boolean;
  steps?: readonly FlowRunStep[];
  source?: { stepId: string | null; stepOrder: number | null };
  fallbackText?: string;
  labelFor?: (speaker: string) => string;
}): [TranscriptContext, (patch: Partial<TranscriptContext>) => void, () => void] {
  const [ctx, setCtx] = useState<TranscriptContext>({ ...INITIAL_TRANSCRIPT, pending: enabled });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadTranscriptContext({ flowId, runId, steps, source, fallbackText, labelFor }).then((next) => {
      if (!cancelled) setCtx(next);
    });
    return () => {
      cancelled = true;
    };
    // Laddas om per körning och vid reload; övriga argument är härledda ur samma checkpoint/run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, runId, enabled, attempt]);

  const patch = (next: Partial<TranscriptContext>) =>
    setCtx((prev) => ({ ...prev, ...next }));
  /** Läser underlaget och de sparade rättningarna igen, t.ex. efter ett nätverksfel. */
  const reload = () => {
    setCtx({ ...INITIAL_TRANSCRIPT, pending: true });
    setAttempt((n) => n + 1);
  };
  return [ctx, patch, reload];
}
