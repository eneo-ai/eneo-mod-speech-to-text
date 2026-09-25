/**
 * Going on from a review pause: save the edit, approve, resume, with Eneo's lost answers read back. The one path
 * for the review's Godkänn / Spara och fortsätt and the naming dialog's Spara och fortsätt.
 */

import {
  approveReviewCheckpoint,
  editReviewCheckpoint,
  getActiveReviewCheckpoint,
  getRun,
  isReviewCheckpointApproved,
  resumeReviewCheckpoint,
  reviewResumeIdempotencyKey,
  type FlowRunPublic,
  type FlowRunReviewCheckpointPublic,
  type Json,
  type ReviewEditedValue,
} from "./api";
import { isSpeakerMappingCheckpoint } from "./speaker-mapping";

/** Said when a changed edit reaches a pause that is already approved: Eneo keeps the decision that was saved. */
export const DECIDED =
  "Granskningen är redan godkänd med det som sparades, så ändringen kan inte sparas. Välj Fortsätt för att gå vidare med det sparade.";

/** Label to name, a label the output leaves out counting as unnamed. */
function namesOf(value: unknown): Map<string, string | null> {
  const speakers = (value as { speakers?: unknown } | null)?.speakers;
  const names = new Map<string, string | null>();
  for (const speaker of Array.isArray(speakers) ? speakers : []) {
    const { label, name } = (speaker ?? {}) as { label?: unknown; name?: unknown };
    if (typeof label === "string") names.set(label, typeof name === "string" && name.trim() ? name.trim() : null);
  }
  return names;
}

/** Whether the pause already holds the edit: the same name for every speaker, or the same text. */
export function holds(checkpoint: FlowRunReviewCheckpointPublic, edit: ReviewEditedValue): boolean {
  const payload = (checkpoint.current_payload_json ?? null) as Json | null;
  if (isSpeakerMappingCheckpoint(payload)) {
    const saved = namesOf((payload as { structured?: unknown }).structured);
    const edited = namesOf(edit);
    return [...new Set([...saved.keys(), ...edited.keys()])].every((label) => (saved.get(label) ?? null) === (edited.get(label) ?? null));
  }
  return typeof edit === "string" && (payload as { text?: unknown } | null)?.text === edit;
}

/** Approves the pause; an approval that went through although its answer was lost is read back. */
async function approveWithRecovery(
  flowId: string,
  runId: string,
  checkpoint: FlowRunReviewCheckpointPublic,
): Promise<FlowRunReviewCheckpointPublic> {
  try {
    return await approveReviewCheckpoint(flowId, runId, checkpoint.id, {
      expected_checkpoint_revision: checkpoint.revision,
    });
  } catch (err) {
    const latest = await getActiveReviewCheckpoint(flowId, runId).catch(() => null);
    if (latest?.id === checkpoint.id && isReviewCheckpointApproved(latest)) return latest;
    throw err;
  }
}

/** Resumes the approved pause; a resume that went through although its answer was lost is read back. */
async function resumeWithRecovery(
  flowId: string,
  runId: string,
  checkpoint: FlowRunReviewCheckpointPublic,
): Promise<FlowRunPublic> {
  const idempotencyKey = reviewResumeIdempotencyKey(runId, checkpoint.id);
  try {
    const resumed = await resumeReviewCheckpoint(
      flowId,
      runId,
      checkpoint.id,
      { expected_checkpoint_revision: checkpoint.revision },
      idempotencyKey,
    );
    return resumed.run;
  } catch (err) {
    const [latestRun, latestCheckpoint] = await Promise.all([
      getRun(flowId, runId).catch(() => null),
      getActiveReviewCheckpoint(flowId, runId).catch(() => null),
    ]);
    const movedPastReview =
      !latestCheckpoint || (latestCheckpoint.id === checkpoint.id && latestCheckpoint.state === "resumed");
    if (latestRun && latestRun.status !== "awaiting_review" && movedPastReview) return latestRun;
    throw err;
  }
}

export async function continueFromPause({
  flowId,
  runId,
  checkpoint,
  edit,
  onCheckpoint,
  onHeld,
}: {
  flowId: string;
  runId: string;
  checkpoint: FlowRunReviewCheckpointPublic;
  /** The step's output as the person has it (the names' mapping, or the text); null when nothing was edited. */
  edit: ReviewEditedValue | null;
  /** Each newer state of the pause (saved, approved), so a retry starts from it. */
  onCheckpoint: (checkpoint: FlowRunReviewCheckpointPublic) => void;
  /** The edit is Eneo's, whether or not the run goes on from here. */
  onHeld?: () => void;
}): Promise<FlowRunPublic> {
  let pause: FlowRunReviewCheckpointPublic = checkpoint;
  if (isReviewCheckpointApproved(checkpoint)) {
    // Approved, the pause takes no more edits and its decision stands: a retry after a failed resume only
    // resumes, and an edit it does not hold is refused, never dropped on the way.
    if (edit !== null && !holds(pause, edit)) throw new Error(DECIDED);
    if (edit !== null) onHeld?.();
  } else {
    if (edit !== null && !holds(pause, edit)) {
      pause = await editReviewCheckpoint(flowId, runId, pause.id, {
        expected_checkpoint_revision: pause.revision,
        edited_value: edit,
      });
      onCheckpoint(pause);
    }
    // Saved now, or held already: from here the edit is Eneo's.
    if (edit !== null) onHeld?.();
    pause = await approveWithRecovery(flowId, runId, pause);
    onCheckpoint(pause);
  }
  return resumeWithRecovery(flowId, runId, pause);
}
