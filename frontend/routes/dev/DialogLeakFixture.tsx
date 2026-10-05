import { useEffect, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { VStack } from "@astryxdesign/core/VStack";
import { Heading } from "@astryxdesign/core/Text";

/** The confirmation every page asks, with the words and the buttons of the leave question. */
function confirmation(isOpen: boolean, set: (open: boolean) => void) {
  return {
    isOpen,
    onOpenChange: set,
    title: "Lämna sidan?",
    description: "Inspelningen finns kvar på enheten.",
    actionLabel: "Lämna sidan",
    cancelLabel: "Stanna kvar",
    onAction: () => set(false),
  };
}

/** A dialog that does what none should: its effect adds a listener that is never taken away, which holds the dialog. */
function LeakyDialog({ close }: { close: () => void }) {
  useEffect(() => {
    const dialog = document.querySelector("dialog[open]");
    document.addEventListener("click", () => void dialog);
  }, []);
  return (
    <Dialog isOpen onOpenChange={close} purpose="form" role="alertdialog" aria-label="Dialog som läcker">
      <DialogHeader title="Dialog som läcker" />
      <Button label="Stäng dialogen som läcker" onClick={close} />
    </Dialog>
  );
}

/**
 * The ways a page can mount a confirmation, for tests/e2e/leaks.spec.ts: once and opened by `isOpen`, as the design
 * system documents it, mounted for each opening, and one that really leaks, which proves the spec can fail.
 */
export function DialogLeakFixture() {
  const [always, setAlways] = useState(false);
  const [perOpening, setPerOpening] = useState(false);
  const [leaky, setLeaky] = useState(false);
  return (
    <VStack gap={3} padding={4} hAlign="start">
      <Heading level={1}>Dialogläckor</Heading>
      <Button label="Monterad en gång" onClick={() => setAlways(true)} />
      <Button label="Monterad vid varje öppning" onClick={() => setPerOpening(true)} />
      <Button label="Läckande dialog" onClick={() => setLeaky(true)} />
      <AlertDialog {...confirmation(always, setAlways)} />
      {perOpening && <AlertDialog {...confirmation(true, setPerOpening)} />}
      {leaky && <LeakyDialog close={() => setLeaky(false)} />}
    </VStack>
  );
}
