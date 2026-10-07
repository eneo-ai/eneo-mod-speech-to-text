import { useCallback, useRef, useState, type MouseEvent } from "react";
import { checkRunArtifact, runArtifactUrl } from "@/lib/api";
import { fileProblem } from "@/lib/errors";

/** How a person gets a run's file: saved, opened in a tab of its own, or by the caller's own way (the preview dialog). */
export type FileWay = "download" | "tab" | { open: () => void };

export interface FileAccess {
  /** Why the file last asked for could not be had, and which file it was; null while nothing failed. */
  problem: { fileId: string; message: string } | null;
  /** Gets the file the way asked once it is known to be there. Call it inside the person's press. */
  start(fileId: string, way: FileWay): void;
  /** Asks again for what failed last. Call it inside the person's press. */
  again(): void;
}

/** Saves what `url` names under the name its answer gives it. */
function save(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.click();
}

/**
 * The one way a result's file reaches a person: asked for before they are sent to it, so that a file Eneo no longer
 * has is said in words, never shown as the module's raw answer in a viewer, a tab or a download under the file's
 * name. A tab is opened by the press itself (a blocker stops one that opens later) and sent to the file once it is
 * there, or closed again.
 */
export function useFileAccess(flowId: string, runId: string): FileAccess {
  const [problem, setProblem] = useState<FileAccess["problem"]>(null);
  const last = useRef<{ fileId: string; way: FileWay } | null>(null);
  const busy = useRef(false);

  const start = useCallback(
    (fileId: string, way: FileWay) => {
      if (busy.current) return;
      busy.current = true;
      last.current = { fileId, way };
      const tab = way === "tab" ? window.open("", "_blank") : null;
      checkRunArtifact(flowId, runId, fileId)
        .then(
          () => {
            setProblem(null);
            if (way === "download") save(runArtifactUrl(flowId, runId, fileId));
            else if (way === "tab") {
              const inline = runArtifactUrl(flowId, runId, fileId, true);
              if (tab) {
                // A tab that cannot reach back to this page.
                tab.opener = null;
                tab.location.replace(inline);
              } else window.open(inline, "_blank", "noopener,noreferrer");
            } else way.open();
          },
          (error: unknown) => {
            tab?.close();
            setProblem({ fileId, message: fileProblem(error) });
          },
        )
        .finally(() => void (busy.current = false));
    },
    [flowId, runId],
  );
  const again = useCallback(() => last.current && start(last.current.fileId, last.current.way), [start]);
  return { problem, start, again };
}

/**
 * The press of a link to a file. The plain press is the page's, which asks first; a press that asks the browser for
 * something of its own (a new tab with ctrl or a middle button, save as) is left to it, as for any link.
 */
export function pressing(access: FileAccess, fileId: string, way: FileWay) {
  return (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    access.start(fileId, way);
  };
}
