/** Swedish formats for sizes, dates and durations: one owner for every view. */

const NBSP = " ";
const oneDecimal = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 });

/** "13,3 kB", "1,2 MB", "100 MB"; binary units, as Eneo's limits are. */
export function formatBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${oneDecimal.format(unit === 0 ? Math.round(value) : value)}${NBSP}${units[unit]}`;
}

const MONTHS = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];
const two = (n: number) => String(n).padStart(2, "0");
const dayNumber = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;

/** "i dag 10:12", "i går 15:40", "21 sep 09:05", "12 dec 2025"; empty for an invalid date. */
export function formatRelativeDate(value: string | Date, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  const daysAgo = dayNumber(now) - dayNumber(date);
  if (daysAgo === 0) return `i dag ${time}`;
  if (daysAgo === 1) return `i går ${time}`;
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${day} ${date.getFullYear()}`;
}

/** "22 s", "32 min", "1 h 5 min"; rounded to the unit shown. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The recording timer: "12:34" under an hour, "1:02:05" from an hour. */
export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** "Inspelning 23 sep 16:13": a recording named for people, not as a file. */
export function recordingName(startedAt: number): string {
  const date = new Date(startedAt);
  return `Inspelning ${date.getDate()} ${MONTHS[date.getMonth()]} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
