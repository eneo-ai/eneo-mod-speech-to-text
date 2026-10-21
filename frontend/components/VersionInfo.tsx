import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { CopyButton } from "@/components/flow/CopyButton";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { buildIdentity, type BuildIdentity } from "@/lib/api";
import { buildView, supportText } from "@/lib/build-identity";

/**
 * Which build of the module runs, for a person whom support asks: folded away under "Version" at the end of the flow
 * list, as Eneo keeps its own at the end of its navigation. The backend's answer is read when it is first opened, not
 * with every page, and kept while the page is open.
 */
export function VersionInfo() {
  const [open, setOpen] = useState(false);
  const [build, setBuild] = useState<BuildIdentity | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  function read() {
    setFailed(false);
    buildIdentity().then(setBuild, () => setFailed(true));
  }

  function toggle(next: boolean) {
    setOpen(next);
    if (next && !build) read();
  }

  // Last and quiet: the chevron beside its word, which is the supporting size in the secondary colour (5.6:1 on the page).
  return (
    <Collapsible
      chevronPosition="start"
      trigger={
        <Text type="supporting" color="secondary">
          Version
        </Text>
      }
      isOpen={open}
      onOpenChange={toggle}
    >
      {build ? (
        <BuildDetails build={build} />
      ) : failed ? (
        <ProblemAlert
          problem={{ title: "Versionen kunde inte visas.", retry: true }}
          onRetry={() => {
            setAttempt((n) => n + 1);
            read();
          }}
          focusRetry={attempt > 0}
        />
      ) : (
        open && <Text type="supporting">Hämtar versionen…</Text>
      )}
    </Collapsible>
  );
}

/** The build as a person reads it, and what support needs of it. */
function BuildDetails({ build }: { build: BuildIdentity }) {
  const view = buildView(build);
  return (
    <VStack gap={4}>
      <MetadataList>
        {view.release && <MetadataListItem label="Utgåva">{view.release}</MetadataListItem>}
        {/* The code's own face, as Eneo's error code has it (RunFailure): the design system's Code chip would be one more
            file for the flow list to fetch, for a fold nearly no one opens. */}
        <MetadataListItem label="Commit">{view.commit ? <Text type="code">{view.commit}</Text> : "Okänd"}</MetadataListItem>
        <MetadataListItem label="Byggd">{view.built ?? "Okänd"}</MetadataListItem>
      </MetadataList>
      <HStack gap={3} wrap="wrap">
        <CopyButton text={supportText(build, window.location.origin)} label="Kopiera supportinformation" />
        {view.commitUrl && (
          <Button
            href={view.commitUrl}
            target="_blank"
            rel="noopener noreferrer"
            icon={<Icon icon="externalLink" />}
            label="Visa commiten på GitHub i en ny flik"
          >
            Visa commiten på GitHub
          </Button>
        )}
      </HStack>
    </VStack>
  );
}
