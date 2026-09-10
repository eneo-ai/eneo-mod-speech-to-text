"use client";

import { useEffect, useState } from "react";
import {
  getRunSteps,
  getTranscriptWords,
  listTranscriptCorrections,
  type FlowRunStep,
} from "@/lib/api";
import {
  attachWords,
  fileIdsFromTranscription,
  parseTranscriptText,
  segmentsFromTranscription,
  type TranscriptSegment,
} from "@/lib/transcript";
import {
  EMPTY_CORRECTIONS,
  type CorrectionSet,
} from "@/lib/transcript-corrections";

export interface TranscriptContext {
  pending: boolean;
  /** Råa segment (etiketter SPEAKER_NN, okorrigerad text). */
  segments: TranscriptSegment[];
  /** Segmenten kom från stegets lagrade metadata (krävs för korrigeringar). */
  fromMetadata: boolean;
  fileIds: string[];
  stepId: string | null;
  /** Sparade korrigeringar för steget, eller tomt set. */
  corrections: CorrectionSet;
  /** Namn per etikett som ett speaker-mapping-steg i körningen redan valt. */
  speakerNames: Record<string, string>;
}

const INITIAL: TranscriptContext = {
  pending: true,
  segments: [],
  fromMetadata: false,
  fileIds: [],
  stepId: null,
  corrections: EMPTY_CORRECTIONS,
  speakerNames: {},
};

function transcriptionOf(step: FlowRunStep | undefined): unknown {
  return (step?.input_payload_json as { transcription?: unknown } | null | undefined)
    ?.transcription;
}

/** Namn ur ett speaker-mapping-stegs output (`structured.speakers`). */
function speakerNamesFromSteps(steps: readonly FlowRunStep[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const step of steps) {
    const output = step.output_payload_json as
      | { structured?: { speakers?: unknown } }
      | null
      | undefined;
    const speakers = output?.structured?.speakers;
    if (!Array.isArray(speakers)) continue;
    for (const item of speakers) {
      const entry = item as { label?: unknown; name?: unknown };
      if (
        typeof entry?.label === "string" &&
        typeof entry.name === "string" &&
        entry.name.trim()
      ) {
        names[entry.label] = entry.name.trim();
      }
    }
  }
  return names;
}

/**
 * Hämtar allt spelaren behöver för en körning: transkriberingsstegets
 * segment och ljudfiler, ordtider (404 = inga), sparade korrigeringar och
 * eventuella namn från ett speaker-mapping-steg.
 *
 * `source` pekar ut transkriberingssteget (från checkpointens
 * `speaker_mapping.source_step_*`); saknas det väljs första steget med
 * transkriptionsmetadata. `fallbackText` parsas om steget saknar segment.
 */
export function useTranscriptContext({
  flowId,
  runId,
  enabled,
  steps: providedSteps,
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
}): [TranscriptContext, (patch: Partial<TranscriptContext>) => void] {
  const [ctx, setCtx] = useState<TranscriptContext>({ ...INITIAL, pending: enabled });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      let segments: TranscriptSegment[] | null = null;
      let fileIds: string[] = [];
      let stepId: string | null = null;
      let corrections: CorrectionSet = EMPTY_CORRECTIONS;
      let speakerNames: Record<string, string> = {};
      try {
        const steps =
          providedSteps && providedSteps.length > 0
            ? providedSteps
            : await getRunSteps(flowId, runId);
        const step =
          (source?.stepId
            ? steps.find((st) => st.step_id === source.stepId)
            : undefined) ??
          (source?.stepOrder != null
            ? steps.find((st) => st.step_order === source.stepOrder)
            : undefined) ??
          steps.find((st) => segmentsFromTranscription(transcriptionOf(st)) !== null);
        const transcription = transcriptionOf(step);
        segments = segmentsFromTranscription(transcription);
        fileIds = fileIdsFromTranscription(transcription);
        if (fileIds.length === 0 && Array.isArray(step?.runtime_input_file_ids)) {
          fileIds = (step.runtime_input_file_ids as unknown[]).filter(
            (id): id is string => typeof id === "string",
          );
        }
        stepId = step?.step_id ?? null;
        speakerNames = speakerNamesFromSteps(steps);
        if (segments && stepId) {
          const [words, sets] = await Promise.all([
            // 404 är normalt: steget lagrade inga ordtider.
            getTranscriptWords(flowId, runId, stepId).catch(() => null),
            listTranscriptCorrections(flowId, runId).catch(() => []),
          ]);
          segments = attachWords(segments, words);
          const own = sets.find((set) => set.step_id === stepId);
          if (own && !own.stale) {
            corrections = {
              occurrences: own.occurrences,
              speaker_edits: own.speaker_edits,
              revision: own.revision,
            };
          }
        }
      } catch {
        // Utan stegdata visas texten som den är, utan ljud.
      }
      if (cancelled) return;
      const fromMetadata = segments !== null;
      setCtx({
        pending: false,
        segments: segments ?? (fallbackText ? parseTranscriptText(fallbackText, labelFor) : []),
        fromMetadata,
        fileIds,
        stepId,
        corrections,
        speakerNames,
      });
    })();
    return () => {
      cancelled = true;
    };
    // Laddas om per körning; övriga argument är härledda ur samma checkpoint/run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, runId, enabled]);

  const patch = (next: Partial<TranscriptContext>) =>
    setCtx((prev) => ({ ...prev, ...next }));
  return [ctx, patch];
}
