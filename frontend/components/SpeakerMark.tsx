import styles from "@/components/SpeakerMark.module.css";
import { speakerColorIndex, speakerInitial } from "@/lib/transcript";

/** A speaker's round mark: the initial on the speaker's colour, the same everywhere on the page. */
export function SpeakerMark({ label, name, size = "md" }: { label: string | null; name: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span aria-hidden className={styles.mark} data-size={size} data-speaker-color={label ? speakerColorIndex(label) : undefined}>
      {label ? speakerInitial(name) : "?"}
    </span>
  );
}
