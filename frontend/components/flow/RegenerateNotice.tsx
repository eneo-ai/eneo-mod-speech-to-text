import { useContext, useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { CorrectionsSaveState } from "@/components/TranscriptPlayer";
import type { FlowRunPublic } from "@/lib/api";
import { regenerate, type RegenerationRequest } from "@/lib/regenerate";
import { LeaveContext } from "./useLeaveQuestion";
import styles from "./RegenerateNotice.module.css";

/**
 * Says, without alarm, that the document was made from the transcript before
 * the saved corrections, and offers to make it again from the corrected one.
 * Nothing happens unless the user asks; the new run is followed like any other.
 *
 * It stands from the page's first draw when the run's own read says the corrections are newer (`offer` null while the
 * transcript is `reading`), so the document under it does not move when the transcript arrives: its button acts once
 * the transcript is read, and if the corrections then cannot make a new document, the same line and the same row say
 * so and offer to read them again.
 */
export function RegenerateNotice({
  offer,
  reading = false,
  saveState,
  onStarted,
  onReload,
  thing = "dokumentet",
}: {
  /** What a new document is made with; null while the transcript is read, or when its corrections cannot make one. */
  offer: RegenerationRequest | null;
  /** The transcript and its corrections are still being read. */
  reading?: boolean;
  /** The transcript's latest save: a new document waits while one runs, and after one failed. */
  saveState: CorrectionsSaveState;
  onStarted: (run: FlowRunPublic) => void;
  /** Reads the transcript and its corrections again, after they changed elsewhere. */
  onReload: () => void;
  /** What the run makes, as the notice names it: "dokumentet", "texten" or "resultatet" (`outputWords`). */
  thing?: string;
}) {
  const { leaveFirst } = useContext(LeaveContext);
  const [working, setWorking] = useState(false);
  const [refusal, setRefusal] = useState<{ message: string; reload: boolean } | null>(null);
  const saving = saveState === "saving";
  const unsaved = saveState === "error";
  // Read, and the corrections cannot make a new document: said in the description's place, with the reading again in
  // the button's.
  const unreadable = !offer && !reading;

  async function start() {
    if (!offer) return;
    setWorking(true);
    setRefusal(null);
    const outcome = await regenerate(offer, thing);
    setWorking(false);
    if (outcome.kind === "started") onStarted(outcome.run);
    else setRefusal(outcome);
  }

  return (
    // A note, not an alarm: it is there when the page opens and needs no announcement (the design system's warning
    // is an alert).
    <Banner
      status="warning"
      role="note"
      collapsible={false}
      title={`${thing[0].toUpperCase() + thing.slice(1)} skapades före dina rättningar`}
      description={
        <OneOf
          first={!unreadable}
          one="Den nya versionen görs från den rättade transkriberingen."
          other="Rättningarna kunde inte läsas just nu."
        />
      }
    >
      <VStack gap={3} hAlign="start">
        <OneOf
          first={!unreadable}
          one={
            <Button
              icon={working ? <Spinner size="sm" aria-hidden /> : <Icon icon={RotateCcw} />}
              isDisabled={working || saving || unsaved || !offer}
              label={working ? `Skapar ${thing} igen…` : saving ? "Sparar rättningarna…" : `Skapa ${thing} igen med rättningarna`}
              onClick={() => leaveFirst(start)}
            />
          }
          other={<Button icon={<Icon icon={RotateCcw} />} label="Läs in igen" onClick={onReload} />}
        />
        {unsaved && (
          <Text as="p" color="secondary">
            Den senaste rättningen är inte sparad. Spara den igen i transkriberingen innan {thing} skapas på nytt.
          </Text>
        )}
        {refusal && (
          <HStack role="alert" wrap="wrap" vAlign="center" gap={3}>
            <Icon icon="error" color="error" />
            <Text>{refusal.message}</Text>
            {refusal.reload && <Button variant="ghost" size="sm" label="Läs in igen" onClick={onReload} />}
          </HStack>
        )}
      </VStack>
    </Banner>
  );
}

/**
 * One of two ways a place can read, both in one cell: the place is as large as the larger, so the notice keeps its size
 * whichever shows, and the document under it stays where it was drawn. The other is hidden from sight, the keyboard
 * and assistive technology.
 */
function OneOf({ first, one, other }: { first: boolean; one: ReactNode; other: ReactNode }) {
  return (
    <span className={styles.oneOf}>
      <span data-shown={first} inert={!first}>
        {one}
      </span>
      <span data-shown={!first} inert={first}>
        {other}
      </span>
    </span>
  );
}
