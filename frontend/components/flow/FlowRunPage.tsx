import { useState, type ReactNode } from "react";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { VStack } from "@astryxdesign/core/VStack";
import { FlowAside } from "@/components/flow/FlowAside";
import { FlowFrame } from "@/components/flow/FlowFrame";
import { OfflineBanner, type OfflineWaiting } from "@/components/OfflineBanner";
import type { FlowPublished, RunContract } from "@/lib/api";
import { detailRows, detailsSummary } from "@/lib/recording-view";
import { ofContractVersion } from "@/lib/run-progress";

/**
 * A run's states on the flow's page (sending, running, opening, unread, failed): the setup's frame, with the
 * flow and the details the run was started with beside the state's card, so only the card changes when the
 * run moves on. The state's card has the page's heading.
 */
export function FlowRunPage({
  published,
  contract,
  input,
  version,
  locked = false,
  offline = null,
  children,
}: {
  published: FlowPublished;
  contract: RunContract;
  /** The details the run was started with (its input payload); unknown while it is being read. */
  input: unknown;
  /** The flow version the details were given on: labelled by the contract's form only when it is the contract's own. */
  version: number | null | undefined;
  /** While an upload is under way: leaving would abort it, so the page offers no way off. */
  locked?: boolean;
  /** What waits while the device is offline, said above the card in every state, so the card never moves. */
  offline?: OfflineWaiting;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const fields = contract.form_fields ?? [];
  const values = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const rows = ofContractVersion({ flow_version: version }, contract) ? detailRows(fields, values) : [];
  return (
    <FlowFrame
      locked={locked}
      aside={
        <FlowAside
          published={published}
          classification={contract.security_classification}
          titleIsHeading={false}
          locked={locked}
          compact
          details={
            rows.length > 0 && (
              <MetadataList label={{ position: "top" }}>
                {rows.map(({ label, text }) => (
                  <MetadataListItem key={label} label={label}>
                    {text}
                  </MetadataListItem>
                ))}
              </MetadataList>
            )
          }
          summary={rows.length > 0 ? detailsSummary(fields, values) : null}
          open={open}
          onOpenChange={setOpen}
        />
      }
    >
      <VStack gap={6}>
        <OfflineBanner waiting={offline} />
        {children}
      </VStack>
    </FlowFrame>
  );
}
