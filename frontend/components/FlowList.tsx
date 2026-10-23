import { FileText, Mic, Paperclip, PenLine, type LucideIcon } from "lucide-react";
import { useId } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { IconTile, type IconTileHue } from "@/components/IconTile";
import type { FlowSparsePublic } from "@/lib/api";
import type { FlowSpaceGroup } from "@/lib/flow-discovery";
import { withLastUsedFirst } from "@/lib/last-used-flow";
import styles from "./FlowList.module.css";
import { useNarrowerThan } from "@/components/flow/useRoomInRow";

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

/** The tile's hue says the same as its icon: audio in the deployment's accent, a document purple, a file teal. */
function inputHue(inputType: FlowSparsePublic["input_type"]): IconTileHue {
  switch (inputType) {
    case "audio":
      return "accent";
    case "document":
      return "purple";
    case "file":
      return "teal";
    default:
      return "neutral";
  }
}

const TABLET = "(min-width: 768px)";
// Below it a row has no tile: every flow's says the same on a phone (most take audio), and its 56 px are the name's.
const TILED = "(min-width: 640px)";

/**
 * The flows the user can run: one card per space, its name and how many flows it holds at the card's head (no head when
 * there is only one), two cards abreast where the column has room. Each flow a full row: its tile from 640 px, the name
 * whole, however long, and the description in at most two lines, three on a phone, whose narrow row would cut the words
 * that tell two flows apart. The flow last used on this device comes first and says so.
 */
export function FlowList({ groups, lastFlowId }: { groups: FlowSpaceGroup[]; lastFlowId: string | null }) {
  if (groups.length === 1) {
    return (
      <Card padding={0}>
        <FlowRows flows={groups[0].flows} lastFlowId={lastFlowId} />
      </Card>
    );
  }
  return (
    // Two cards abreast where the column has room for two of 440 px, one across it where it has not (FlowList.module.css).
    <div className={styles.spaces}>
      {groups.map((group) => (
        <SpaceSection key={group.spaceId} group={group} lastFlowId={lastFlowId} />
      ))}
    </div>
  );
}

function SpaceSection({ group, lastFlowId }: { group: FlowSpaceGroup; lastFlowId: string | null }) {
  const headingId = useId();
  const count = group.flows.length;
  // A named region, as the screen reader's list of landmarks has it. The count stays with the name: it drops under a
  // long name as a unit rather than splitting.
  return (
    <Card padding={0} role="region" aria-labelledby={headingId}>
      <HStack gap={3} wrap="wrap" className={styles.cardHead}>
        <Heading level={2} id={headingId}>
          {group.spaceName}
        </Heading>
        <Text color="secondary" hasTabularNumbers>
          {count === 1 ? "1 flöde" : `${count} flöden`}
        </Text>
      </HStack>
      <Divider />
      <FlowRows flows={group.flows} lastFlowId={lastFlowId} />
    </Card>
  );
}

function FlowRows({ flows, lastFlowId }: { flows: FlowSparsePublic[]; lastFlowId: string | null }) {
  const tablet = useMediaQuery(TABLET, true);
  const tiled = useMediaQuery(TILED, true);
  // A description keeps two or three lines; where the reader's large text leaves the list under 16 rem of the root's text
  // those lines hold a few words, and the description is whole instead.
  const room = useNarrowerThan(16);
  return (
    <List hasDividers density="spacious" className={styles.rows} ref={room.ref}>
      {withLastUsedFirst(flows, lastFlowId).map((flow) => (
        <ListItem
          key={flow.id}
          className={styles.row}
          href={`/flows/${flow.id}`}
          startContent={tiled ? <IconTile icon={inputIcon(flow.input_type)} hue={inputHue(flow.input_type)} size={tablet ? "lg" : "md"} /> : undefined}
          // Nodes, not strings: a string is cut to one line with an ellipsis, and a name is never cut. "Senast använd" is
          // said after the name, set apart from it, and stays on the name's line, under it where the line has no room:
          // the description keeps its own two lines.
          label={
            flow.id === lastFlowId ? (
              <HStack gap={2} wrap="wrap" vAlign="center">
                <Text weight="semibold">{flow.name}</Text>
                <VisuallyHidden>, </VisuallyHidden>
                <Token size="sm" color="blue" label="Senast använd" description="Senast använd på den här enheten" />
              </HStack>
            ) : (
              <Text weight="semibold">{flow.name}</Text>
            )
          }
          description={
            flow.description ? (
              <Text type="supporting" color="secondary" maxLines={room.narrow ? undefined : tablet ? 2 : 3} hasTruncateTooltip={false} textWrap="pretty">
                {flow.description}
              </Text>
            ) : undefined
          }
          endContent={<Icon icon="chevronRight" color="secondary" className={styles.chevron} />}
        />
      ))}
    </List>
  );
}

/** The list's shape while it loads, so nothing moves when it arrives: a card of rows with their tiles, at the rows' size. */
export function FlowListSkeleton() {
  const tile = useMediaQuery(TABLET, true) ? 48 : 40;
  const tiled = useMediaQuery(TILED, true);
  return (
    <Card padding={0}>
      <List hasDividers density="spacious" className={styles.rows} aria-hidden>
        {[0, 1, 2, 3].map((row) => (
          <ListItem
            key={row}
            className={styles.row}
            startContent={tiled ? <Skeleton width={tile} height={tile} radius={3} index={row} /> : undefined}
            label={<Skeleton width="60%" height={16} index={row} />}
            description={<Skeleton width="80%" height={14} index={row} />}
          />
        ))}
      </List>
    </Card>
  );
}
