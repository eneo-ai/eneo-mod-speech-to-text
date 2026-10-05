import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useSignedOut } from "@/components/AuthGate";
import { BackToFlows } from "@/components/flow/BackToFlows";
import { runElapsed, type StepView } from "@/lib/run-progress";
import { creatingHeading } from "@/lib/flow-output";
import { PRODUCT_NAME } from "@/lib/product";
import { StepList } from "./StepList";
import { StateCard } from "./StateCard";
import { usePhaseHeading } from "./usePhaseHeading";

/** The run goes on in Eneo: what happens now, for how long, every step, and a way to stop it. */
export function RunProgress({
  flowName,
  steps,
  stage,
  startedAt,
  error = null,
  makesText = false,
  onCancel,
}: {
  flowName: string;
  steps: readonly StepView[];
  stage: string;
  /** When Eneo created the run; unknown until its first status read. */
  startedAt?: string | null;
  error?: string | null;
  /** The flow ends in text, not a file (lib/flow-output makesText). */
  makesText?: boolean;
  onCancel: () => Promise<void>;
}) {
  const heading = usePhaseHeading(`${makesText ? "Skapar text" : "Skapar dokument"} · ${flowName}`);
  const [cancelling, setCancelling] = useState(false);
  // The cancel question is a page dialog: it is closed while the login has ended and asked again after the new one,
  // so `asking` lives here, above the dialog.
  const [asking, setAsking] = useState(false);
  const signedOut = useSignedOut();
  // Answered, or closed with Escape: the focus is back on the button that asked. The dialog gives it back itself, but
  // not after a new login, when it was opened again with nothing of the page focused.
  const trigger = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    if (!asking && wasAsking.current) trigger.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = runElapsed(startedAt, now);

  async function cancel() {
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  }

  return (
    <StateCard>
      <VStack gap={6}>
        <VStack gap={2}>
          <Heading level={1} ref={heading} tabIndex={-1}>
            {creatingHeading(makesText)}
          </Heading>
          <VStack gap={1}>
            <HStack gap={2} align="center">
              <Spinner size="sm" aria-hidden />
              <Text as="p" role="status">
                {stage}
              </Text>
            </HStack>
            {/* Outside the status region: the minutes count on without being read out. */}
            <Text as="p" type="supporting">
              {elapsed && `${elapsed}. `}Det kan ta några minuter.
            </Text>
          </VStack>
        </VStack>
        {steps.length > 0 && (
          <VStack as="section" aria-label="Flödets steg">
            <StepList steps={steps} />
          </VStack>
        )}
        {/* Reassurance for a page closed by mistake, not a request to close it. */}
        <Text as="p" type="supporting">
          {makesText
            ? "Texten blir klar även om du stänger sidan. Du hittar den här sedan."
            : "Dokumentet blir klart även om du stänger sidan. Du hittar det här sedan."}
        </Text>
        {error && <Banner status="error" title={error} collapsible={false} />}
        <HStack>
          <Button ref={trigger} label="Avbryt körningen" variant="secondary" isLoading={cancelling} onClick={() => setAsking(true)} />
        </HStack>
        <AlertDialog
          isOpen={asking && !signedOut}
          onOpenChange={setAsking}
          title="Avbryta körningen?"
          description={`Flödet slutar arbeta och ${makesText ? "ingen text" : "inget dokument"} skapas.`}
          cancelLabel="Kör vidare"
          actionLabel="Avbryt körningen"
          onAction={() => {
            setAsking(false);
            void cancel();
          }}
        />
      </VStack>
    </StateCard>
  );
}

/** Opening an earlier run: the shape of the view until its state is known. */
export function RunOpening() {
  return (
    <StateCard aria-busy="true">
      <VStack gap={6}>
        <VisuallyHidden as="h1">{PRODUCT_NAME}</VisuallyHidden>
        <VisuallyHidden as="p" role="status">
          Hämtar körningen…
        </VisuallyHidden>
        <Skeleton width="66%" height={28} />
        <Skeleton width="50%" height={20} />
        <Skeleton width="100%" height={128} radius={4} />
      </VStack>
    </StateCard>
  );
}

/** The run has ended but its result could not be read: say so, and read it again. */
export function RunUnread({ message, onRetry }: { message: string; onRetry: () => void }) {
  const heading = usePhaseHeading("Resultatet kunde inte hämtas");
  return (
    <StateCard>
      <VStack gap={6}>
        <VStack gap={2}>
          <Heading level={1} ref={heading} tabIndex={-1}>
            Resultatet kunde inte hämtas
          </Heading>
          <Text as="p">{message}</Text>
          <Text as="p" type="supporting">
            Körningen är avslutad och finns kvar i Eneo.
          </Text>
        </VStack>
        <HStack gap={3} wrap="wrap">
          <Button label="Försök igen" variant="primary" icon={<Icon icon={RotateCcw} size="sm" color="inherit" />} onClick={onRetry} />
          <BackToFlows size="md" />
        </HStack>
      </VStack>
    </StateCard>
  );
}
