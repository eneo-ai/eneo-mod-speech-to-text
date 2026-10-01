import { FileText, Mic, Paperclip, PenLine, type LucideIcon } from "lucide-react";
import { useId } from "react";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { FlowSparsePublic } from "@/lib/api";
import type { FlowSpaceGroup } from "@/lib/flow-discovery";
import { withLastUsedFirst } from "@/lib/flow-session";
import styles from "./FlowList.module.css";

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

/**
 * The flows the user can run, one heading per space (none when there is only
 * one), each flow a full row: the name whole, however long, and the
 * description in at most two lines. The flow last used comes first.
 */
export function FlowList({ groups, lastFlowId }: { groups: FlowSpaceGroup[]; lastFlowId: string | null }) {
  return (
    <VStack gap={10}>
      {groups.map((group) =>
        groups.length > 1 ? (
          <SpaceSection key={group.spaceId} group={group} lastFlowId={lastFlowId} />
        ) : (
          <FlowRows key={group.spaceId} flows={group.flows} lastFlowId={lastFlowId} />
        ),
      )}
    </VStack>
  );
}

function SpaceSection({ group, lastFlowId }: { group: FlowSpaceGroup; lastFlowId: string | null }) {
  const headingId = useId();
  // A named region, as the screen reader's list of landmarks has it. (Section is no help: it bleeds past its
  // parent's padding and is no landmark.)
  return (
    <VStack role="region" aria-labelledby={headingId} gap={3}>
      <Heading level={2} id={headingId}>
        {group.spaceName}
      </Heading>
      <FlowRows flows={group.flows} lastFlowId={lastFlowId} />
    </VStack>
  );
}

function FlowRows({ flows, lastFlowId }: { flows: FlowSparsePublic[]; lastFlowId: string | null }) {
  return (
    <List hasDividers>
      {withLastUsedFirst(flows, lastFlowId).map((flow) => (
        <ListItem
          key={flow.id}
          className={styles.row}
          href={`/flows/${flow.id}`}
          startContent={<Icon icon={inputIcon(flow.input_type)} color="accent" />}
          // Nodes, not strings: a string is cut to one line with an ellipsis, and a name is never cut.
          label={<Text weight="semibold">{flow.name}</Text>}
          description={
            flow.description ? (
              <Text type="supporting" maxLines={2} hasTruncateTooltip={false}>
                {flow.description}
              </Text>
            ) : undefined
          }
          endContent={<Icon icon="chevronRight" color="secondary" />}
        />
      ))}
    </List>
  );
}

/** The list's shape while it loads, so nothing moves when it arrives. */
export function FlowListSkeleton() {
  return (
    <List hasDividers aria-hidden>
      {[0, 1, 2, 3].map((row) => (
        <ListItem
          key={row}
          startContent={<Skeleton width={24} height={24} index={row} />}
          label={<Skeleton width="60%" height={16} index={row} />}
          description={<Skeleton width="80%" height={14} index={row} />}
        />
      ))}
    </List>
  );
}
