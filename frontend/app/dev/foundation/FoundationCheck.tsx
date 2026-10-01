"use client";

import {useState} from "react";
import {AppShell} from "@astryxdesign/core/AppShell";
import {TopNav} from "@astryxdesign/core/TopNav";
import {Button} from "@astryxdesign/core/Button";
import {TextInput} from "@astryxdesign/core/TextInput";
import {Switch} from "@astryxdesign/core/Switch";
import {Selector} from "@astryxdesign/core/Selector";
import {Banner} from "@astryxdesign/core/Banner";
import {Dialog} from "@astryxdesign/core/Dialog";
import {AlertDialog} from "@astryxdesign/core/AlertDialog";
import {DropdownMenu} from "@astryxdesign/core/DropdownMenu";
import {VStack} from "@astryxdesign/core/VStack";
import {Heading, Text} from "@astryxdesign/core/Text";
import {Card} from "@astryxdesign/core/Card";
import {Button as LegacyButton} from "@/components/ui/button";

/**
 * One page of the design system's parts beside the old ones, for the checks that a broken foundation fails on every
 * page at once: the cascade layers, the built theme, the colour mode, touch sizes and the overlays.
 */
export function FoundationCheck() {
  const [text, setText] = useState("");
  const [on, setOn] = useState(false);
  const [speaker, setSpeaker] = useState("a");
  const [dialog, setDialog] = useState(false);
  const [alert, setAlert] = useState(false);
  const [covered, setCovered] = useState(false);
  return (
    <div inert={covered} data-cover>
      <AppShell
        height="auto"
        contentPadding={4}
        mobileNav={false}
        topNav={
          <TopNav
            label="Tal till text"
            heading={<Text weight="semibold">Tal till text</Text>}
            endContent={<DropdownMenu button={{label: "Konto"}} items={[{label: "Logga ut", onClick() {}}]} />}
          />
        }>
        <div data-foundation-check>
          <VStack gap={4}>
            <Heading level={1}>Grundkontroll</Heading>
            <Banner status="warning" title="Flödet har uppdaterats" description="Läs in sidan igen." collapsible={false} />
            <Button label="Primär" variant="primary" onClick={() => setDialog(true)} />
            <Button label="Liten" size="sm" variant="secondary" onClick={() => setAlert(true)} />
            <LegacyButton onClick={() => setCovered(true)}>Legacy shadcn-knapp</LegacyButton>
            <TextInput label="Ärende" placeholder="Skriv ärendet" value={text} onChange={setText} />
            <Switch label="Märk upp talare" value={on} onChange={setOn} />
            <Selector label="Talare" value={speaker} onChange={setSpeaker} options={[{value: "a", label: "Anna Berg"}, {value: "b", label: "Erik Lund"}]} />
            <Card>Ett kort med standardutfyllnad och en lång rad text som måste radbrytas på en smal skärm utan att sidan rullar i sidled.</Card>
            <p className="rounded-lg bg-primary-soft p-4 text-ink">Tailwind-klasser fungerar fortfarande.</p>
          </VStack>
        </div>
        <Dialog isOpen={dialog} onOpenChange={setDialog} purpose="required" role="alertdialog" aria-label="Du behöver logga in igen">
          <VStack gap={3}>
            <Text>Logga in igen för att fortsätta.</Text>
            <Button label="Stäng" onClick={() => setDialog(false)} />
          </VStack>
        </Dialog>
        <AlertDialog isOpen={alert} onOpenChange={setAlert} title="Lämna sidan?" description="Inspelningen finns kvar på enheten." actionLabel="Lämna sidan" cancelLabel="Stanna kvar" onAction={() => setAlert(false)} />
      </AppShell>
    </div>
  );
}
