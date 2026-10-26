import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { FILE_GONE, fileGone, fileProblem } from "@/lib/errors";
import { readInputFileAudio, type FlowRunStep } from "@/lib/api";
import { asOneFile, downloadBlob } from "@/lib/download";
import type { Problem } from "@/lib/flow-session";
import type { NamedBlob } from "@/lib/zip";
import { runInputFiles } from "@/lib/run-files";
import type { StepView } from "@/lib/run-progress";
import { saveLabel } from "@/components/save-recording";
import { ProblemAlert } from "./ProblemAlert";
// A ghost button's icon on the edge the column's words start from.
import styles from "./RunResult.module.css";
import { useFileAccess, waiting } from "./useFileAccess";

/**
 * "Spara ljudfil": a run's recording as Eneo has it, in one press, whatever became of the run; the device's copy is
 * gone once Eneo took the run. Only a step its own version reads as audio gave a recording (`steps`, from the run's own
 * graph); a document is not offered as one, and a run given none offers nothing.
 *
 * One file is asked for first and saved as the browser streams it, so that a file Eneo no longer has is said in words.
 * The parts of a recording are read into the page and saved together in a zip, since a browser may block a second
 * download a press starts; each part is at most the flow's largest file. A part Eneo no longer has keeps none of the
 * others from being saved, and is named.
 */
export function SaveRunRecording({
  flowId,
  runId,
  steps,
  stepResults,
  iconSize = "md",
}: {
  flowId: string;
  runId: string;
  steps: readonly StepView[];
  stepResults: readonly FlowRunStep[];
  /** As the page's other quiet actions have theirs, so that their words start on one edge. */
  iconSize?: "sm" | "md";
}) {
  const given = runInputFiles(stepResults);
  const recording = given && steps.some((step) => step.order === given.step.step_order && step.transcribes);
  return recording ? <SaveFiles flowId={flowId} runId={runId} fileIds={given.fileIds} iconSize={iconSize} /> : null;
}

function SaveFiles({ flowId, runId, fileIds, iconSize }: { flowId: string; runId: string; fileIds: readonly string[]; iconSize: "sm" | "md" }) {
  const access = useFileAccess(flowId, runId, "given");
  const [parts, setParts] = useState<{ busy: boolean; problem: Problem | null }>({ busy: false, problem: null });
  // Set at once, so a second press in the same moment finds the first one reading.
  const reading = useRef(false);
  // A screen left while the parts are read ends the read under way, reads no more of them and saves nothing.
  const gone = useRef(false);
  const reads = useRef<AbortController | null>(null);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      reads.current?.abort();
    };
  }, []);
  const one = fileIds.length === 1;
  async function save() {
    if (one) return void access.start(fileIds[0], "download");
    if (reading.current) return;
    reading.current = true;
    reads.current = new AbortController();
    setParts({ busy: true, problem: null });
    try {
      const files: NamedBlob[] = [];
      const missing: number[] = [];
      // One part at a time: the module streams a person's files a few at once.
      for (const [index, fileId] of fileIds.entries()) {
        if (gone.current) return;
        try {
          files.push(await readInputFileAudio(flowId, runId, fileId, index, reads.current.signal));
        } catch (error) {
          // Asking again cannot bring back a part Eneo no longer has: the others are saved, and it is named.
          if (!fileGone(error)) throw error;
          missing.push(index + 1);
        }
      }
      if (files.length === 0) return setParts({ busy: false, problem: { title: FILE_GONE, retry: true } });
      const { blob, filename } = await asOneFile(files);
      if (gone.current) return;
      downloadBlob(blob, filename);
      setParts({ busy: false, problem: missing.length ? partsMissing(missing, fileIds.length) : null });
    } catch (error) {
      if (!gone.current) setParts({ busy: false, problem: { title: fileProblem(error), retry: true } });
    } finally {
      reading.current = false;
    }
  }
  const problem = one ? access.problem && { title: access.problem.message, retry: true } : parts.problem;
  return (
    <VStack gap={2}>
      <HStack>
        <Button
          variant="ghost"
          label={saveLabel(fileIds.length)}
          icon={<Icon icon={Download} size={iconSize} color="inherit" />}
          {...(one ? waiting(access, fileIds[0], "download") : { isLoading: parts.busy, isInterruptible: true })}
          onClick={() => void save()}
          className={styles.quietStart}
        />
      </HStack>
      {problem && <ProblemAlert problem={problem} onRetry={() => void save()} />}
    </VStack>
  );
}

/** "Del 2 av 3 finns inte kvar hos Eneo.": the parts a save left out, which no new try brings back. */
function partsMissing(missing: readonly number[], of: number): Problem {
  const which = new Intl.ListFormat("sv", { type: "conjunction" }).format(missing.map(String));
  return { title: `Del ${which} av ${of} finns inte kvar hos Eneo.`, detail: "Filen innehåller de andra delarna." };
}
