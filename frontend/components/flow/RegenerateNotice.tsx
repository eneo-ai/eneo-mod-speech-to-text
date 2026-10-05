import { useState } from "react";
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
    // A note, not an alarm: it is there when the page opens and needs no announcement (the design system's warning
    // is an alert).
    <Banner
      status="warning"
      role="note"
      collapsible={false}
      title={`${thing[0].toUpperCase() + thing.slice(1)} skapades före dina rättningar`}
      description="Den nya versionen görs från den rättade transkriberingen."
    >
      <VStack gap={3} hAlign="start">
        <Button
          icon={working ? <Spinner size="sm" aria-hidden /> : <Icon icon={RotateCcw} />}
          isDisabled={working || saving || unsaved}
          label={working ? `Skapar ${thing} igen…` : saving ? "Sparar rättningarna…" : `Skapa ${thing} igen med rättningarna`}
          onClick={() => void start()}
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
