import { Pause, Play } from "lucide-react";
import { useContext, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { SignedOutSlot } from "@/components/AuthGate";
import { LevelMeter } from "@/components/flow/LevelMeter";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { useElapsed } from "@/components/flow/recording-hooks";
import type { Problem, SessionPhase } from "@/lib/flow-session";
import { formatClock } from "@/lib/format";
import type { RecordingCapture } from "@/lib/recording-session";
import { stopLine } from "@/lib/recording-view";
import styles from "./Recorder.module.css";

// Pausa and Stoppa appear under the finger that tapped Starta: a double tap's second tap must not end the meeting.
const SETTLE_MS = 700;

/** "Spelar in" with the red dot while the recorder records; "Pausad" otherwise. Never colour alone. */
function RecordingStatus({ phase, size = "base" }: { phase: SessionPhase; size?: "base" | "lg" }) {
  const recording = phase === "recording";
  return (
    <HStack as="span" gap={2} align="center">
      {recording ? <span aria-hidden className={styles.dot} /> : <Icon icon={Pause} size="sm" color="secondary" />}
      <Text weight="medium" size={size}>
        {recording ? "Spelar in" : "Pausad"}
      </Text>
    </HStack>
  );
}

/** The recorded time (paused time excluded), from the recorder itself. */
function Timer({
  capture,
  phase,
  weight,
  className,
}: {
  capture: RecordingCapture;
  phase: SessionPhase;
  weight?: "medium";
  className?: string;
}) {
  const elapsed = useElapsed(capture, phase === "recording");
  return (
    <Text hasTabularNumbers weight={weight} className={className}>
      {formatClock(elapsed)}
    </Text>
  );
}

/** Spela in's workspace: the status, a large timer and a calm level. */
export function FocusedRecorder({
  capture,
  phase,
  stream,
}: {
  capture: RecordingCapture;
  phase: SessionPhase;
  stream: MediaStream | null;
}) {
  return (
    <Card padding={6} className={styles.stage}>
      <VStack align="center" gap={6}>
        <VisuallyHidden as="h2" data-phase-heading tabIndex={-1}>
          Inspelning
        </VisuallyHidden>
        <RecordingStatus phase={phase} size="lg" />
        <Timer capture={capture} phase={phase} className={styles.timer} />
        <LevelMeter
          stream={phase === "recording" ? stream : null}
          bars={25}
          variant="wave"
          className={styles.stageMeter}
        />
        <Text as="p" color="secondary" className={styles.note}>
          {/* Where the recording is kept was said under Starta inspelning: once per view. */}
          Texten skapas när du stoppar inspelningen.
        </Text>
      </VStack>
    </Card>
  );
}

/**
 * The recording's controls in fixed places: Pausa (Fortsätt while paused or
 * interrupted) and Stoppa, with warnings above them and the line saying what
 * else matters now under them. With
 * `showStatus`, the status, timer and level ride along (Strömma, where the
 * document sheet has the workspace).
 */
export function RecordingBar({
  capture,
  phase,
  stream,
  showStatus,
  warnings,
  notes,
  makesText = false,
  onPause,
  onStop,
}: {
  capture: RecordingCapture;
  phase: SessionPhase;
  stream: MediaStream | null;
  showStatus: boolean;
  /** What can lose the meeting: said as alerts, above the controls. */
  warnings: Problem[];
  notes: string[];
  /** The flow ends in text, not a file. */
  makesText?: boolean;
  onPause: () => void;
  onStop: () => void;
}) {
  const running = phase === "recording";
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    shownAt.current = Date.now();
  }, []);
  const settled = (act: () => void) => () => {
    if (shownAt.current !== null && Date.now() - shownAt.current >= SETTLE_MS) act();
  };
  const marker = showStatus ? "" : undefined;
  return (
    <div className={styles.bar} data-status={marker}>
      <VStack gap={3} className={styles.barStack}>
        {warnings.length > 0 && (
          <VStack gap={2} className={styles.warnings}>
            {warnings.map((warning) => (
              <ProblemAlert key={warning.title} problem={warning} />
            ))}
          </VStack>
        )}
        <VStack gap={3} className={styles.controls}>
          <div className={styles.row} data-status={marker}>
            {showStatus && (
              <div className={styles.readout}>
                <RecordingStatus phase={phase} />
                <div className={styles.readoutLine}>
                  <Timer capture={capture} phase={phase} weight="medium" />
                  <LevelMeter stream={running ? stream : null} bars={8} variant="steps" className={styles.statusMeter} />
                </div>
              </div>
            )}
            <div className={styles.actions}>
              <Button
                label={running ? "Pausa" : "Fortsätt"}
                variant="secondary"
                size="lg"
                width="100%"
                icon={<Icon icon={running ? Pause : Play} size="md" />}
                onClick={settled(onPause)}
              />
              <Button
                label="Stoppa"
                variant="primary"
                size="lg"
                width="100%"
                icon={<Icon icon="stop" size="md" />}
                onClick={settled(onStop)}
              />
            </div>
          </div>
          <VStack gap={0.5} className={styles.notes} data-status={marker}>
            {/* Always there, so a new note is said once; the fixed line under it is not said again with each. */}
            <VStack role="status" gap={0.5}>
              {notes.map((note) => (
                <Text as="p" type="supporting" key={note}>
                  {note}
                </Text>
              ))}
            </VStack>
            <Text as="p" type="supporting" className={styles.stopLine}>
              {stopLine(makesText)}
            </Text>
          </VStack>
        </VStack>
      </VStack>
    </div>
  );
}

/**
 * While the page is covered for a new login, a recording's Pausa and Stoppa stay in reach in the sign-in dialog:
 * ending a meeting needs no login, and what is recorded stays on the device either way.
 */
export function SignedOutControls({ phase, onPause, onStop }: { phase: SessionPhase; onPause: () => void; onStop: () => void }) {
  const slot = useContext(SignedOutSlot);
  if (!slot || (phase !== "recording" && phase !== "paused")) return null;
  return createPortal(
    <HStack role="group" aria-label="Inspelningen" gap={2} wrap="wrap" justify="between" align="center">
      <RecordingStatus phase={phase} />
      <HStack gap={2}>
        <Button
          label={phase === "recording" ? "Pausa" : "Fortsätt"}
          variant="secondary"
          icon={<Icon icon={phase === "recording" ? Pause : Play} size="sm" />}
          onClick={onPause}
        />
        <Button label="Stoppa" variant="primary" icon={<Icon icon="stop" size="sm" />} onClick={onStop} />
      </HStack>
    </HStack>,
    slot,
  );
}

/**
 * Shown by the stopped recording's page. When it comes up under the cover (Stoppa was pressed in the sign-in dialog), the
 * buttons that were pressed are gone with the recording's view: the dialog says the recording is stopped and kept, and
 * the focus stays in it, on those words.
 */
export function StoppedWhileSignedOut() {
  const slot = useContext(SignedOutSlot);
  const underCover = useRef(slot !== null);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (underCover.current) line.current?.focus();
  }, []);
  if (!underCover.current || !slot) return null;
  return createPortal(
    <Text as="p" role="status" tabIndex={-1} ref={line}>
      Inspelningen är stoppad och sparad.
    </Text>,
    slot,
  );
}
