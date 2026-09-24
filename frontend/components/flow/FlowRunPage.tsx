"use client";

import { useState, type ReactNode } from "react";
import { FlowAside } from "@/components/flow/FlowAside";
import { FlowTopBar } from "@/components/flow/FlowTopBar";
import { FLOW_GRID, FRAME } from "@/components/frame";
import { OfflineBanner, type OfflineWaiting } from "@/components/OfflineBanner";
import type { FlowPublished, RunContract } from "@/lib/api";
import { detailRows, detailsSummary } from "@/lib/recording-view";
import { ofContractVersion } from "@/lib/run-progress";
import { cn } from "@/lib/utils";

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
    <div className="flex min-h-dvh flex-col">
      <FlowTopBar title={published.name} titleIsHeading={false} locked={locked} />
      <main id="innehall" className={cn(FRAME, FLOW_GRID, "flex-1 pb-12 pt-3 lg:items-start lg:pt-8")}>
        <FlowAside
          published={published}
          classification={contract.security_classification}
          titleIsHeading={false}
          locked={locked}
          compact
          details={
            rows.length > 0 && (
              <dl className="flex flex-col gap-3">
                {rows.map(({ label, text }) => (
                  <div key={label} className="flex flex-col gap-0.5">
                    <dt className="text-[15px] font-medium text-ink">{label}</dt>
                    <dd className="text-[15px] leading-relaxed text-ink-soft [overflow-wrap:anywhere]">{text}</dd>
                  </div>
                ))}
              </dl>
            )
          }
          summary={rows.length > 0 ? detailsSummary(fields, values) : null}
          open={open}
          onOpenChange={setOpen}
        />
        <div className="mt-4 flex min-w-0 flex-col gap-6 lg:mt-0">
          <OfflineBanner waiting={offline} />
          {children}
        </div>
      </main>
    </div>
  );
}
