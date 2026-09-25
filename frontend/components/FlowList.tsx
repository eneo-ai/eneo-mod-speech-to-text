import { ChevronRight, FileText, Mic, Paperclip, PenLine, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import type { FlowSparsePublic } from "@/lib/api";
import type { FlowSpaceGroup } from "@/lib/flow-discovery";
import { withLastUsedFirst } from "@/lib/flow-session";

/** How the flow takes its input (Eneo's `input_type`); a flow with no file or audio asks only for details. */
export function inputIcon(inputType: FlowSparsePublic["input_type"]): LucideIcon {
  switch (inputType) {
    case "audio":
      return Mic;
    case "document":
      return FileText;
    case "file":
      return Paperclip;
    default:
      return PenLine;
  }
}

// One column on a phone and tablet; two on a laptop, as rows, not tiles.
const LIST = "grid gap-3 lg:grid-cols-2";

/**
 * The flows the user can run, one heading per space (none when there is only
 * one), each flow a full row: the name whole, however long, and the
 * description in at most two lines. The flow last used comes first.
 */
export function FlowList({ groups, lastFlowId }: { groups: FlowSpaceGroup[]; lastFlowId: string | null }) {
  return (
    <div className="flex flex-col gap-10">
      {groups.map((group) =>
        groups.length > 1 ? (
          <SpaceSection key={group.spaceId} group={group} lastFlowId={lastFlowId} />
        ) : (
          <FlowRows key={group.spaceId} flows={group.flows} lastFlowId={lastFlowId} />
        ),
      )}
    </div>
  );
}

function SpaceSection({ group, lastFlowId }: { group: FlowSpaceGroup; lastFlowId: string | null }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-[19px] font-semibold leading-snug tracking-[-0.01em] text-ink">
        {group.spaceName}
      </h2>
      <FlowRows flows={group.flows} lastFlowId={lastFlowId} />
    </section>
  );
}

function FlowRows({ flows, lastFlowId }: { flows: FlowSparsePublic[]; lastFlowId: string | null }) {
  return (
    <ItemGroup className={LIST}>
      {withLastUsedFirst(flows, lastFlowId).map((flow) => {
        const Icon = inputIcon(flow.input_type);
        return (
          <div role="listitem" key={flow.id} className="flex">
            <Item asChild variant="outline" className="w-full flex-nowrap items-start rounded-xl bg-card hover:bg-accent">
              <Link href={`/flows/${flow.id}`}>
                <ItemMedia className="size-10 self-start rounded-lg bg-primary-soft text-primary [&_svg]:size-5">
                  <Icon aria-hidden strokeWidth={1.75} />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="w-auto text-[17px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
                    {flow.name}
                  </ItemTitle>
                  {flow.description && (
                    <ItemDescription className="text-[15px] leading-snug text-ink-soft text-pretty">{flow.description}</ItemDescription>
                  )}
                </ItemContent>
                <ItemActions className="self-center">
                  <ChevronRight aria-hidden className="size-5 text-muted-foreground" />
                </ItemActions>
              </Link>
            </Item>
          </div>
        );
      })}
    </ItemGroup>
  );
}

/** The list's shape while it loads, so nothing moves when it arrives. */
export function FlowListSkeleton() {
  return (
    <div className={LIST} aria-hidden>
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-start gap-4 rounded-xl border border-border bg-card p-4">
          <Skeleton className="size-10 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
