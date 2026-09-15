import { applyCorrections, correctedSegmentText, occurrencesForLine, withSpeakerDecision, type CorrectionSet } from "./transcript-corrections";
import { needsSpeakerReview, type SpeakerDecision, type TranscriptSegment } from "./transcript";

export interface TextSelectionSpan { segmentIndex: number; start: number; end: number }
export interface DisplaySelectionSpan { index: number; start: number; end: number }

/** Keep source paragraphs coherent, joining continuations when effective speakers agree. */
export function transcriptParagraphs(shown: readonly TranscriptSegment[], raw: readonly TranscriptSegment[]) {
  const paragraphs: number[][] = [];
  shown.forEach((segment, index) => {
    if (!segment.text) return;
    const previousIndex = paragraphs.at(-1)?.at(-1);
    const previous = previousIndex === undefined ? undefined : shown[previousIndex];
    const source = raw[segment.sourceSegmentIndex ?? index];
    const previousSource = previous && raw[previous.sourceSegmentIndex ?? previousIndex!];
    const identity = (s: TranscriptSegment | undefined) => s?.modelSpeaker ?? s?.speaker;
    const group = paragraphs[paragraphs.length - 1];
    const length = group?.reduce((n, i) => n + shown[i].text.length, 0) ?? 0;
    const previousSpeechIndex = group?.slice().reverse().find((i) => shown[i].text.trim());
    const previousSpeech = previousSpeechIndex === undefined ? undefined : shown[previousSpeechIndex];
    const settled = (s: TranscriptSegment) => s.decision === "confirmed" ||
      s.decision !== "unresolved" && s.speakerAttribution !== "unassigned" && !needsSpeakerReview(s);
    const continuation = Boolean(previousSpeech?.speaker && segment.speaker === previousSpeech.speaker &&
      settled(previousSpeech) && settled(segment));
    const sameSource = previous && segment.sourceSegmentIndex !== undefined && segment.sourceSegmentIndex === previous.sourceSegmentIndex;
    if (!previous || previous.fileIndex !== segment.fileIndex || (!sameSource &&
      ((identity(source) !== identity(previousSource) && !continuation) || segment.start - previous.end > 3 || length > 650))) paragraphs.push([index]);
    else group.push(index);
  });
  return paragraphs;
}

function rawToDisplay(offset: number, segmentIndex: number, set: CorrectionSet): number {
  return offset + set.occurrences.filter((o) => o.segment_index === segmentIndex && o.char_end <= offset)
    .reduce((n, o) => n + o.corrected.length - (o.char_end - o.char_start), 0);
}
function displayToRaw(offset: number, segmentIndex: number, set: CorrectionSet, edge: "start" | "end"): number {
  let delta = 0;
  for (const o of set.occurrences.filter((o) => o.segment_index === segmentIndex).sort((a, b) => a.char_start - b.char_start)) {
    const start = o.char_start + delta, end = start + o.corrected.length;
    if (offset < start) break;
    if (offset === start) return o.char_start;
    if (offset < end) return edge === "start" ? o.char_start : o.char_end;
    delta += o.corrected.length - (o.char_end - o.char_start);
  }
  return offset - delta;
}

/** Offer one quick confirmation only when the selection has a single compatible suggestion. */
export function selectionSpeakerSuggestion(spans: readonly TranscriptSegment[]): string | null {
  const words = spans.filter((s) => s.text.trim());
  const suggestion = words[0]?.modelSpeaker === undefined ? words[0]?.speaker : words[0].modelSpeaker;
  if (!suggestion || !/^SPEAKER_\d{2,}$/.test(suggestion)) return null;
  return words.every((s) => (s.modelSpeaker === undefined ? s.speaker : s.modelSpeaker) === suggestion &&
    (!s.decision || s.decision === "confirmed" && s.speaker === suggestion)) ? suggestion : null;
}

/** Select the complete visible passage, including punctuation and boundary whitespace. */
export function wholePassageSelection(index: number, shown: readonly TranscriptSegment[], raw: readonly TranscriptSegment[]): TextSelectionSpan[] {
  const segment = shown[index];
  if (!segment?.text.trim()) return [];
  const segmentIndex = segment.sourceSegmentIndex ?? index;
  const source = raw[segmentIndex];
  if (!source) return [];
  return [{ segmentIndex, start: segment.sourceCharStart ?? 0, end: segment.sourceCharEnd ?? source.text.length }];
}

/** Snap native text selection to words and resolve immutable raw anchors, including corrected text. */
export function anchorTextSelection(selection: readonly DisplaySelectionSpan[], shown: readonly TranscriptSegment[], set: CorrectionSet): TextSelectionSpan[] {
  const result: TextSelectionSpan[] = [];
  for (const span of selection) {
    const segment = shown[span.index];
    if (!segment || span.end <= span.start) continue;
    const words = [...segment.text.matchAll(/\S+/gu)].filter((m) => m.index! < span.end && m.index! + m[0].length > span.start);
    if (!words.length) continue;
    const index = segment.sourceSegmentIndex ?? span.index;
    const base = rawToDisplay(segment.sourceCharStart ?? 0, index, set);
    const start = displayToRaw(base + words[0].index!, index, set, "start");
    const last = words[words.length - 1];
    const end = displayToRaw(base + last.index! + last[0].length, index, set, "end");
    const previous = result[result.length - 1];
    if (previous?.segmentIndex === index) previous.end = Math.max(previous.end, end);
    else result.push({ segmentIndex: index, start, end });
  }
  return result;
}

export function displayedSelectionBounds(span: TextSelectionSpan, segment: TranscriptSegment, index: number, set: CorrectionSet) {
  if ((segment.sourceSegmentIndex ?? index) !== span.segmentIndex) return null;
  const base = rawToDisplay(segment.sourceCharStart ?? 0, span.segmentIndex, set);
  const start = Math.max(0, rawToDisplay(span.start, span.segmentIndex, set) - base);
  const end = Math.min(segment.text.length, rawToDisplay(span.end, span.segmentIndex, set) - base);
  return end > start ? { start, end } : null;
}

export function selectedTranscriptText(selection: readonly TextSelectionSpan[], raw: readonly TranscriptSegment[], set: CorrectionSet) {
  return selection.map((span) => {
    const text = correctedSegmentText(raw[span.segmentIndex].text, set.occurrences.filter((o) => o.segment_index === span.segmentIndex));
    return text.slice(rawToDisplay(span.start, span.segmentIndex, set), rawToDisplay(span.end, span.segmentIndex, set));
  }).join(" ");
}

/** One atomic replacement list for a selection spanning any number of source segments. */
export function assignTextSelection(set: CorrectionSet, raw: readonly TranscriptSegment[], selection: readonly TextSelectionSpan[], decision: SpeakerDecision | null, speaker: string | null) {
  return selection.reduce((next, span) => withSpeakerDecision(next, raw, span.segmentIndex,
    span.start === 0 && span.end === raw[span.segmentIndex].text.length ? null : span.start,
    span.start === 0 && span.end === raw[span.segmentIndex].text.length ? null : span.end, decision, speaker), set);
}


/** Position within the corrected source, independent of rendered word and speaker spans. */
export function displayedSourceOffset(segment: TranscriptSegment, index: number, offset: number, set: CorrectionSet) {
  const segmentIndex = segment.sourceSegmentIndex ?? index;
  return { segmentIndex, offset: rawToDisplay(segment.sourceCharStart ?? 0, segmentIndex, set) + offset };
}

/** Exact character editing: never snap a caret to words or rewrite speaker decisions. */
export function replaceTranscriptText(set: CorrectionSet, raw: readonly TranscriptSegment[], shown: readonly TranscriptSegment[], ranges: readonly DisplaySelectionSpan[], text: string) {
  if (!ranges.length) throw new Error("Placera markören i transkripttexten.");
  let next = set;
  const first = ranges[0];
  if (!shown[first.index]) throw new Error("Markeringen behöver göras om.");
  const caret = displayedSourceOffset(shown[first.index], first.index, first.start, set);
  ranges.forEach((range, i) => {
    const segment = shown[range.index];
    if (!segment || range.start < 0 || range.end < range.start || range.end > segment.text.length) throw new Error("Markeringen behöver göras om.");
    const sourceIndex = segment.sourceSegmentIndex ?? range.index;
    const source = raw[sourceIndex];
    const start = segment.sourceCharStart ?? 0, end = segment.sourceCharEnd ?? source.text.length;
    const replacement = segment.text.slice(0, range.start) + (i === 0 ? text : "") + segment.text.slice(range.end);
    // Diff inside each existing speaker partition so punctuation at its edge cannot
    // absorb an adjacent speaker's words. All anchors remain in the original text.
    const edits = occurrencesForLine(sourceIndex, source.text.slice(start, end), replacement)
      .map((o) => ({ ...o, char_start: o.char_start + start, char_end: o.char_end + start }));
    next = { ...next, occurrences: [
      ...next.occurrences.filter((o) => o.segment_index !== sourceIndex || o.char_end <= start || o.char_start >= end), ...edits,
    ].sort((a, b) => a.segment_index - b.segment_index || a.char_start - b.char_start) };
  });
  applyCorrections(raw, next);
  return { corrections: next, caret: { ...caret, offset: caret.offset + text.length } };
}


/** Pending, attributable suggestions only; existing human decisions are never bulk-replaced. */
export function pendingSpeakerSuggestions(raw: readonly TranscriptSegment[], shown: readonly TranscriptSegment[], set: CorrectionSet, selection?: readonly TextSelectionSpan[]) {
  return shown.flatMap((segment, index) => {
    if (!needsSpeakerReview(segment) || segment.decision || !segment.text.trim()) return [];
    const speaker = selectionSpeakerSuggestion([segment]);
    if (!speaker || segment.speaker !== speaker) return [];
    const whole = wholePassageSelection(index, shown, raw)[0];
    if (!whole) return [];
    const ranges = selection ? selection.filter((s) => s.segmentIndex === whole.segmentIndex)
      .map((s) => ({ segmentIndex: s.segmentIndex, start: Math.max(s.start, whole.start), end: Math.min(s.end, whole.end) }))
      .filter((s) => s.end > s.start) : [whole];
    return ranges.filter((range) => !set.speaker_edits.some((edit) => edit.segment_index === range.segmentIndex &&
      (edit.char_start ?? 0) < range.end && (edit.char_end ?? Infinity) > range.start))
      .map((range) => ({ range, speaker }));
  });
}

/** One full-list save and one undo action, even when proposals name different speakers. */
export function confirmSpeakerSuggestions(set: CorrectionSet, raw: readonly TranscriptSegment[], suggestions: ReturnType<typeof pendingSpeakerSuggestions>) {
  return suggestions.reduce((next, { range, speaker }) => assignTextSelection(next, raw, [range], "confirmed", speaker), set);
}
