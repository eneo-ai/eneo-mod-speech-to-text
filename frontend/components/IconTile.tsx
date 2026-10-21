import type { LucideIcon } from "lucide-react";
import { Center } from "@astryxdesign/core/Center";
import { Icon } from "@astryxdesign/core/Icon";

/**
 * What a tile's hue means (never a hash of a name): the accent follows the deployment's colour (audio, the document's
 * file, the classification); purple is a document, teal a file, green a success, neutral what is quiet.
 */
export type IconTileHue = "accent" | "neutral" | "purple" | "teal" | "green";

/**
 * A coloured, rounded tile around an icon, as web-next's composites/icon-tile: 32, 40 or 48 px with a 16, 20 or 24 px
 * icon. Decorative (aria-hidden): the name or the words beside it carry the meaning. Its look is in styles/globals.css
 * (`data-icon-tile`): every page draws tiles, and a stylesheet of its own would be one more request on each of them.
 */
export function IconTile({ icon, hue = "accent", size = "md" }: { icon: LucideIcon; hue?: IconTileHue; size?: "sm" | "md" | "lg" }) {
  return (
    <Center aria-hidden data-icon-tile={hue} data-size={size}>
      <Icon icon={icon} size={size} color="inherit" />
    </Center>
  );
}
