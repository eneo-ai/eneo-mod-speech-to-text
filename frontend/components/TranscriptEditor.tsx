"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCheck, ChevronDown, Play, Undo2, X } from "lucide-react";
import { wordKey } from "@/lib/confirmed-words";
import { cn } from "@/lib/utils";
import { formatClock, playbackWordHighlights, needsSpeakerReview, speakerColorIndex, type TranscriptSegment } from "@/lib/transcript";
import { reviewPassages, type FileSpeakerReview } from "@/lib/speaker-review";
import { applyCorrections, correctedSegmentText, EMPTY_CORRECTIONS, occurrencesForLine, withLineCorrection, type CorrectionSet } from "@/lib/transcript-corrections";
import { confirmSpeakerSuggestions, pendingSpeakerSuggestions, displayedSourceOffset, replaceTranscriptText, anchorTextSelection, selectionSpeakerSuggestion, wholePassageSelection, assignTextSelection, displayedSelectionBounds, selectedTranscriptText, transcriptParagraphs, type DisplaySelectionSpan, type TextSelectionSpan } from "@/lib/transcript-selection";

const tint = (speaker: string | null) => speaker ? `hsl(var(--speaker-${speakerColorIndex(speaker)}))` : "hsl(var(--ink-mute))";
const action = "inline-flex min-w-6 max-w-full whitespace-normal [overflow-wrap:anywhere] min-h-9 items-center justify-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium hover:bg-bg-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40 disabled:cursor-default";

export function TranscriptEditor({ raw, shown, corrections = EMPTY_CORRECTIONS, reviews, editable, textEditable, onChange, displayName, speakerOptions, audioAvailable, currentFile, currentTime, playing, onSeek, onInteract, confirmedWords, onToggleConfirmed }: {
  confirmedWords: ReadonlySet<string>; onToggleConfirmed?: (key: string) => void;
  raw: readonly TranscriptSegment[]; shown: readonly TranscriptSegment[]; corrections?: CorrectionSet;
  reviews: readonly FileSpeakerReview[]; editable: boolean; textEditable: boolean;
  onChange?: (set: CorrectionSet) => void; displayName: (speaker: string | null) => string;
  speakerOptions: readonly string[]; audioAvailable: boolean; currentFile: number; currentTime: number; playing: boolean;
  onSeek: (file: number, time: number, autoplay?: boolean, end?: number) => void; onInteract: () => void;
}) {
  const helpId = useId();
  const detailsId = useId();
  const editorRoot = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<{ segmentIndex: number; offset: number } | null>(null);
  const [caretParagraph, setCaretParagraph] = useState(0);
  const [selection, setSelection] = useState<TextSelectionSpan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [details, setDetails] = useState(false);
  const [wordless, setWordless] = useState<{ fileIndex: number; start: number; end: number } | null>(null);
  const [undo, setUndo] = useState<{ before: CorrectionSet; after: CorrectionSet } | null>(null);
  const paragraphs = useMemo(() => transcriptParagraphs(shown, raw), [shown, raw]);
  const pending = reviewPassages(shown, reviews);
  const allSuggestions = pendingSpeakerSuggestions(raw, shown, corrections);
  const selectedSuggestions = selection.length ? pendingSpeakerSuggestions(raw, shown, corrections, selection) : [];
  const highlightedWords = useMemo(() => playbackWordHighlights(shown, currentFile, currentTime), [shown, currentFile, currentTime]);
  const selectedText = selectedTranscriptText(selection, raw, corrections);
  const wordCount = selectedText.match(/\S+/gu)?.length ?? 0;
  const selectedSources = selection.map((s) => raw[s.segmentIndex]);
  const selectedSpans = shown.filter((s, index) => selection.some((span) => displayedSelectionBounds(span, s, index, corrections)));
  const suggestion = selectionSpeakerSuggestion(selectedSpans);
  const suggestionConfirmed = suggestion !== null && selectedSpans.filter((s) => s.text.trim()).every((s) => s.decision === "confirmed");
  const hasDecision = selection.some((span) => corrections.speaker_edits.some((e) => e.segment_index === span.segmentIndex && (e.char_start ?? 0) < span.end && (e.char_end ?? Infinity) > span.start));
  const undoAvailable = undo && JSON.stringify(undo.after.speaker_edits) === JSON.stringify(corrections.speaker_edits) && JSON.stringify(undo.after.occurrences) === JSON.stringify(corrections.occurrences);

  function choose(next: TextSelectionSpan[], focus = false) {
    setSelection(next); setEditing(false); setError(null); setWordless(null); setNotice(""); onInteract();
    if (focus) requestAnimationFrame(() => {
      const first = next[0];
      const index = shown.findIndex((s, i) => first && displayedSelectionBounds(first, s, i, corrections));
      body.current?.querySelector(`[data-text-span="${index}"]`)?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    });
  }
  function captureSelection() {
    if (editing) return;
    const native = window.getSelection();
    if (!native || native.isCollapsed || !native.rangeCount || !body.current) return;
    const range = native.getRangeAt(0);
    if (!body.current.contains(range.startContainer) || !body.current.contains(range.endContainer)) return;
    const spans: DisplaySelectionSpan[] = [];
    body.current.querySelectorAll<HTMLElement>("[data-text-span]").forEach((element) => {
      if (!range.intersectsNode(element)) return;
      const offset = (node: Node, position: number, fallback: number) => {
        if (!element.contains(node)) return fallback;
        const prefix = document.createRange(); prefix.selectNodeContents(element); prefix.setEnd(node, position);
        return prefix.toString().length;
      };
      spans.push({ index: Number(element.dataset.textSpan), start: offset(range.startContainer, range.startOffset, 0), end: offset(range.endContainer, range.endOffset, element.textContent?.length ?? 0) });
    });
    const next = anchorTextSelection(spans, shown, corrections);
    if (next.length && JSON.stringify(next) !== JSON.stringify(selection)) choose(next);
  }
  // Native selection handles on touch screens update after pointer events.
  useEffect(() => {
    const changed = () => {
      const anchor = window.getSelection()?.anchorNode;
      const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor?.parentElement;
      const paragraph = element?.closest<HTMLElement>("[data-turn-index]");
      if (paragraph && body.current?.contains(paragraph)) setCaretParagraph(Number(paragraph.dataset.turnIndex));
      captureSelection();
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  });

  function focusTools() {
    const tools = toolbar.current?.querySelector<HTMLElement>('[aria-label="Markerade ord"]') ?? toolbar.current;
    tools?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled)')?.focus();
  }
  // Reserve space for the actual toolbar height when scrolling keyboard focus into view.
  useEffect(() => {
    if (!toolbar.current) return;
    const observer = new ResizeObserver(() => {
      const height = toolbar.current && getComputedStyle(toolbar.current).position === "sticky" ? toolbar.current.offsetHeight + 16 : 16;
      editorRoot.current?.style.setProperty("--transcript-toolbar-height", `${height}px`);
    });
    observer.observe(toolbar.current);
    return () => observer.disconnect();
  }, []);

  function publish(next: CorrectionSet, message: string) {
    const focused = document.activeElement as HTMLElement | null;
    applyCorrections(raw, next);
    setUndo({ before: corrections, after: next }); onChange?.(next); setNotice(message); setError(null); setEditing(false);
    window.getSelection()?.removeAllRanges();
    if (focused && toolbar.current?.contains(focused)) requestAnimationFrame(() => {
      if (!focused.isConnected || focused.matches(":disabled")) {
        (toolbar.current?.querySelector<HTMLElement>('[data-undo]:not(:disabled)') ?? body.current)?.focus({ preventScroll: true });
      }
    });
  }
  function exactRanges(range: AbstractRange): DisplaySelectionSpan[] {
    if (!body.current?.contains(range.startContainer) || !body.current.contains(range.endContainer)) return [];
    const elements = Array.from(body.current.querySelectorAll<HTMLElement>("[data-text-span]"));
    const position = (node: Node, offset: number) => {
      const element = (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>("[data-text-span]");
      if (!element) return null;
      const prefix = document.createRange(); prefix.selectNodeContents(element); prefix.setEnd(node, offset);
      return { index: Number(element.dataset.textSpan), offset: prefix.toString().length };
    };
    const start = position(range.startContainer, range.startOffset), end = position(range.endContainer, range.endOffset);
    if (!start || !end) return [];
    return elements.map((element) => Number(element.dataset.textSpan)).filter((index) => index >= start.index && index <= end.index)
      .map((index) => ({ index, start: index === start.index ? start.offset : 0, end: index === end.index ? end.offset : shown[index].text.length }));
  }
  function typeText(text: string, range?: AbstractRange) {
    if (!textEditable || !onChange) return;
    const native = window.getSelection();
    const target = range ?? (native?.rangeCount ? native.getRangeAt(0) : undefined);
    if (!target) return;
    try {
      const result = replaceTranscriptText(corrections, raw, shown, exactRanges(target), text);
      pendingCaret.current = result.caret;
      publish(result.corrections, "Texten är rättad.");
      setSelection([]); onInteract();
    } catch (e) { setError(e instanceof Error ? e.message : "Texten kunde inte rättas."); }
  }
  // Intercept native editing before the browser changes React's word markup.
  // Target ranges also give exact browser deletion units (including emoji).
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const input = (event: InputEvent) => {
      event.preventDefault();
      if (!textEditable) return;
      const range = event.getTargetRanges?.()[0];
      if (event.inputType === "insertText" || event.inputType === "insertReplacementText") typeText(event.data ?? "", range);
      else if (event.inputType.startsWith("delete")) typeText("", range);
      else if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") typeText("\n", range);
    };
    element.addEventListener("beforeinput", input);
    return () => element.removeEventListener("beforeinput", input);
  });
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (!caret || !body.current) return;
    pendingCaret.current = null;
    for (const element of Array.from(body.current.querySelectorAll<HTMLElement>("[data-text-span]"))) {
      const index = Number(element.dataset.textSpan), segment = shown[index];
      const base = displayedSourceOffset(segment, index, 0, corrections);
      if (base.segmentIndex !== caret.segmentIndex || caret.offset < base.offset || caret.offset > base.offset + segment.text.length) continue;
      let remaining = caret.offset - base.offset;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && remaining > (node.textContent?.length ?? 0)) { remaining -= node.textContent?.length ?? 0; node = walker.nextNode(); }
      const range = document.createRange();
      range.setStart(node ?? element, node ? remaining : 0); range.collapse(true);
      body.current.focus({ preventScroll: true });
      window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
      break;
    }
  }, [shown, corrections]);
  function assign(speaker: string | null, reset = false) {
    if (!editable || !selection.length || (!audioAvailable && speaker !== null && !reset)) return;
    try { publish(assignTextSelection(corrections, raw, selection, reset ? null : speaker ? "confirmed" : "unresolved", speaker),
      reset ? "Talarbeslut återställda." : speaker ? `${wordCount} ord tilldelade ${displayName(speaker)}.` : "Markerade ord är granskade och lämnade oavgjorda."); }
    catch (e) { setError(e instanceof Error ? e.message : "Ändringen kunde inte sparas."); }
  }
  function confirmSuggestions(suggestions: typeof allSuggestions) {
    if (!editable || !audioAvailable || !suggestions.length) return;
    try {
      publish(confirmSpeakerSuggestions(corrections, raw, suggestions), `${suggestions.length} ${suggestions.length === 1 ? "förslag bekräftat" : "förslag bekräftade"}.`);
      onInteract();
    } catch (e) { setError(e instanceof Error ? e.message : "Förslagen kunde inte bekräftas."); }
  }
  function navigate(direction: number) {
    if (!pending.length) return;
    const anchor = selection[0];
    const current = pending.findIndex((p) => p.segmentIndex === null ? wordless?.fileIndex === p.fileIndex && wordless.start === p.start :
      anchor && displayedSelectionBounds(anchor, shown[p.segmentIndex], p.segmentIndex, corrections));
    let targetIndex: number;
    if (current >= 0) targetIndex = (current + direction + pending.length) % pending.length;
    else if (anchor) {
      const after = pending.findIndex((p) => p.segmentIndex !== null && ((shown[p.segmentIndex].sourceSegmentIndex ?? p.segmentIndex) > anchor.segmentIndex ||
        (shown[p.segmentIndex].sourceSegmentIndex === anchor.segmentIndex && (shown[p.segmentIndex].sourceCharStart ?? 0) >= anchor.end)));
      targetIndex = direction > 0 ? (after < 0 ? 0 : after) : (after <= 0 ? pending.length - 1 : after - 1);
    } else targetIndex = direction > 0 ? 0 : pending.length - 1;
    const passage = pending[targetIndex];
    if (passage.segmentIndex !== null) {
      choose(wholePassageSelection(passage.segmentIndex, shown, raw), true);
    } else { setSelection([]); setWordless(passage); setDetails(true); onInteract(); }
  }
  function replay() {
    const first = selection[0];
    const source = first && raw[first.segmentIndex];
    const words = source?.words?.filter((w) => first && w.charStart < first.end && w.charEnd > first.start);
    const target = source ?? wordless;
    if (target) {
      const last = selection[selection.length - 1];
      const lastSource = last && raw[last.segmentIndex];
      const lastWords = lastSource?.words?.filter((w) => last && w.charStart < last.end && w.charEnd > last.start);
      const end = lastSource?.fileIndex === target.fileIndex ? lastWords?.at(-1)?.end ?? lastSource.end : target.end;
      onSeek(target.fileIndex, Math.max(0, (words?.[0]?.start ?? target.start) - 1.5), true, end + 1); onInteract();
    }
  }
  function saveText() {
    if (!textEditable || !selection.length) return;
    try {
      let next = corrections;
      selection.forEach((span, index) => {
        const source = raw[span.segmentIndex];
        const full = correctedSegmentText(source.text, corrections.occurrences.filter((o) => o.segment_index === span.segmentIndex));
        const bounds = displayedSelectionBounds(span, { ...source, text: full, sourceSegmentIndex: span.segmentIndex, sourceCharStart: 0 }, span.segmentIndex, corrections);
        if (!bounds) throw new Error("Markeringen behöver göras om.");
        const edited = full.slice(0, bounds.start) + (index === 0 ? draft : "") + full.slice(bounds.end);
        next = withLineCorrection(next, span.segmentIndex, occurrencesForLine(span.segmentIndex, source.text, edited));
      });
      publish(next, "Texten är rättad."); setSelection([]);
    } catch (e) { setError(e instanceof Error ? e.message : "Texten kunde inte rättas."); }
  }

  function textSpan(segment: TranscriptSegment, index: number) {
    if (!segment.text.trim()) return <span key={index} data-text-span={index} data-segment-index={index}>{segment.text}</span>;
    const bounds = selection.flatMap((span) => { const b = displayedSelectionBounds(span, segment, index, corrections); return b ? [b] : []; });
    const words = (segment.words ?? []).filter((w) => w.charStart >= 0);
    const cuts = [...new Set([0, segment.text.length, ...bounds.flatMap((b) => [b.start, b.end]), ...words.flatMap((w) => [w.charStart, w.charEnd])])].filter((n) => n >= 0 && n <= segment.text.length).sort((a, b) => a - b);
    const uncertain = needsSpeakerReview(segment) && !segment.decision;
    const label = segment.decision === "unresolved" ? "Talare går inte att avgöra" : uncertain ? `Förslag: ${displayName(segment.modelSpeaker === undefined ? segment.speaker : segment.modelSpeaker)} · Inte granskat` : displayName(segment.speaker);
    return <span key={index} data-text-span={index} data-segment-index={index}
      role="button" tabIndex={0} aria-disabled={!uncertain && !audioAvailable ? true : undefined}
      aria-label={uncertain ? `Markera hela passagen: ${segment.text.trim()}. ${label}` : `Flytta uppspelningen till: ${segment.text.trim()}. ${label}`}
      title={uncertain ? `Klicka för att markera hela passagen. ${label}` : audioAvailable ? `Klicka på ett ord för att flytta uppspelningen hit. ${label}` : `Ljudet är inte tillgängligt. ${label}`}
      onClick={(e) => {
        // Leave native drag selection intact, including selections across passages.
        if (e.detail > 1 || !window.getSelection()?.isCollapsed) return;
        if (uncertain) { choose(wholePassageSelection(index, shown, raw)); return; }
        if (!audioAvailable || editing) return;
        const wordElement = (e.target as HTMLElement).closest<HTMLElement>("[data-word-start]");
        const time = wordElement ? Number(wordElement.dataset.wordStart) : Number.NaN;
        setSelection([]);
        onSeek(segment.fileIndex, Number.isFinite(time) ? time : segment.start, playing);
        onInteract();
      }}
      onKeyDown={(e) => {
        if (document.activeElement !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault(); e.stopPropagation();
        if (uncertain) {
          window.getSelection()?.removeAllRanges();
          choose(wholePassageSelection(index, shown, raw));
          requestAnimationFrame(focusTools);
        } else if (audioAvailable && !editing) {
          window.getSelection()?.removeAllRanges(); setSelection([]);
          onSeek(segment.fileIndex, segment.start, playing); onInteract();
        }
      }}
      className={cn("py-1 decoration-[1.5px] underline-offset-[6px]", uncertain ? "cursor-pointer underline decoration-dotted hover:bg-ochre/10 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" : cn("underline decoration-solid focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary", audioAvailable && "cursor-pointer hover:bg-primary/10"))}
      style={{ textDecorationColor: uncertain || segment.decision === "unresolved" ? "hsl(var(--ochre))" : tint(segment.speaker) }}>
      {cuts.slice(0, -1).map((start, i) => {
        const end = cuts[i + 1];
        const word = words.find((w) => w.charStart <= start && w.charEnd >= end);
        const selected = bounds.some((b) => start < b.end && end > b.start);
        const active = segment.fileIndex === currentFile && (word ? currentTime >= word.start && currentTime < word.end : !words.length && currentTime >= segment.start && currentTime < segment.end);
        const currentWord = Boolean(word && highlightedWords.has(word));
        return <span key={start} data-word-start={word?.start} aria-current={currentWord ? "true" : undefined}
          className={cn("rounded-[2px]", selected && "ring-1 ring-primary/40", currentWord ? "bg-primary text-primary-foreground" : selected ? "bg-primary/25" : active ? "bg-primary/10" : word?.uncertain && !confirmedWords.has(wordKey(segment.sourceSegmentIndex ?? index, word)) ? "bg-ochre/15" : undefined)}>{segment.text.slice(start, end)}</span>;
      })}
    </span>;
  }
  return <div ref={editorRoot} className="transcript-editor relative">
    <div ref={toolbar} className="transcript-toolbar sticky top-0 z-10 border-b border-rule-soft bg-paper px-4 py-2 shadow-sm" role="group" aria-label="Transkriptverktyg">
      <div className="flex flex-wrap items-center justify-between gap-1 text-[12px]">
        <span aria-live="polite" className="text-ink-mute">{pending.length ? `${pending.length} ${pending.length === 1 ? "ställe" : "ställen"} att granska` : "Inga väntande talarbeslut"}</span>
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={cn(action, "text-primary")} disabled={!editable || !audioAvailable || !allSuggestions.length}
            title="Bekräfta återstående talarförslag i hela transkriptet. Varje passage behåller sin föreslagna talare. Dina tidigare beslut bevaras."
            onClick={() => confirmSuggestions(allSuggestions)}><CheckCheck className="h-3.5 w-3.5" /> Bekräfta alla förslag{allSuggestions.length > 0 ? ` (${allSuggestions.length})` : ""}</button>
          <button type="button" className={action} disabled={!pending.length} onClick={() => navigate(-1)} aria-label="Föregående passage som behöver talarbeslut">Föregående</button>
          <button type="button" className={cn(action, "text-primary")} disabled={!pending.length} onClick={() => navigate(1)} aria-label="Nästa passage som behöver talarbeslut">Nästa</button>
          <button type="button" className={action} aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(!details)}>Detaljer <ChevronDown className="h-3 w-3" /></button>
        </div>
      </div>
      {selection.length > 0 && <div className="border-t border-rule-soft pt-2 pb-1" role="group" aria-label="Markerade ord">
        <div className="flex items-center gap-2 text-[12px]"><span className="min-w-0 flex-1 truncate font-medium" title={selectedText}>“{selectedText}”</span><span className="shrink-0 text-ink-mute">{wordCount} ord</span>
          <button type="button" className={action} aria-label="Avmarkera" onClick={() => { setSelection([]); setEditing(false); window.getSelection()?.removeAllRanges(); body.current?.focus({ preventScroll: true }); }}><X className="h-3.5 w-3.5" /></button></div>
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={action} disabled={!audioAvailable} onClick={replay}><Play className="h-3.5 w-3.5" /> Lyssna</button>
          {suggestion && <button type="button" className={cn(action, "bg-primary/10 text-primary hover:bg-primary/20")}
            disabled={!editable || !audioAvailable || suggestionConfirmed}
            onClick={() => assign(suggestion)}>
            <Check className="h-3.5 w-3.5" /> {suggestionConfirmed ? "Bekräftad:" : "Bekräfta"} {displayName(suggestion)}
          </button>}
          {!suggestion && selectedSuggestions.length > 0 && <button type="button" className={cn(action, "bg-primary/10 text-primary hover:bg-primary/20")}
            disabled={!editable || !audioAvailable} title="Bekräfta talarförslagen i markeringen, var och en med sin föreslagna talare."
            onClick={() => confirmSuggestions(selectedSuggestions)}><CheckCheck className="h-3.5 w-3.5" /> Bekräfta förslagen i markeringen ({selectedSuggestions.length})</button>}
          <label className={cn(action, "bg-bg-2")}><span className="sr-only">Tilldela talare</span><select aria-label="Tilldela talare" className="min-h-6 max-w-full sm:max-w-[12rem] bg-transparent py-1" value="" disabled={!editable} onChange={(e) => { if (e.target.value) assign(e.target.value === "unresolved" ? null : e.target.value); }}>
            <option value="" disabled>Tilldela talare…</option>
            {speakerOptions.map((speaker) => <option key={speaker} value={speaker} disabled={!audioAvailable}>{displayName(speaker)}{selectedSpans.length && selectedSpans.every((s) => s.speaker === speaker) ? " – bekräfta" : ""}</option>)}
            <option value="unresolved">Går inte att avgöra</option>
          </select></label>
          <button type="button" className={action} disabled={!textEditable} onClick={() => { setDraft(selectedText); setEditing(true); onInteract(); }}>Rätta text</button>
          <button type="button" className={action} disabled={!editable || !hasDecision} onClick={() => assign(null, true)}>Återställ talare</button>
        </div>
        {!audioAvailable && <p className="py-1 text-[12px] text-ink-mute">Ljudet saknas. Talarbeslut kan återställas eller lämnas oavgjorda.</p>}
        {!editable && <p className="py-1 text-[12px] text-ink-mute">Talargranskningen är skrivskyddad.</p>}
        {editing && <form onSubmit={(e) => { e.preventDefault(); saveText(); }} className="py-2">
          <label className="text-[12px] font-medium">Rätta markerad text<textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} className="mt-2 block min-h-24 w-full rounded-md border border-rule bg-paper p-3 text-[15px] leading-relaxed outline-primary" /></label>
          <div className="mt-2 flex gap-2"><button type="submit" className={cn(action, "bg-primary text-primary-foreground")}><Check className="h-3.5 w-3.5" /> Spara text</button><button type="button" className={action} onClick={() => { setEditing(false); requestAnimationFrame(focusTools); }}>Avbryt</button></div>
        </form>}
      </div>}
      <div className="flex flex-wrap items-center gap-2 text-[12px]"><span role="status" aria-atomic="true" className="text-ink-mute">{notice}</span>{undoAvailable && <button type="button" data-undo className={action} disabled={!textEditable} onClick={() => {
        onChange?.({ ...corrections, occurrences: undo!.before.occurrences, speaker_edits: undo!.before.speaker_edits }); setUndo(null); setNotice("Ändringen är ångrad."); body.current?.focus({ preventScroll: true });
      }}><Undo2 className="h-3.5 w-3.5" /> Ångra</button>}</div>
      {error && <p role="alert" className="py-2 text-[12px] text-primary">{error}</p>}
    </div>
    <section id={detailsId} hidden={!details} aria-label="Talargranskning" className="border-b border-rule-soft bg-bg-2/40 px-5 py-3 text-[12px] leading-relaxed">
      <h2 className="font-semibold">Om markeringen</h2>
      {wordless && <p>Inga transkriptord finns för intervallet {formatClock(wordless.start)}–{formatClock(wordless.end)} i del {wordless.fileIndex + 1}. <button type="button" className="underline" disabled={!audioAvailable} onClick={replay}>Lyssna på intervallet</button></p>}
      {new Set(selectedSources.map((s) => s.fileIndex)).size > 1 && <p>Markeringen omfattar flera ljudfiler. Lyssna spelar den första delen.</p>}
      {selectedSources.length ? [...new Set(selectedSources.map((s) => displayName(s.modelSpeaker === undefined ? s.speaker : s.modelSpeaker)))].map((name) => <p key={name}>Modellens förslag: {name}</p>) : !wordless && <p>Markera ord i transkriptet för att se talarförslag och granskningsstatus.</p>}
      {selectedSpans.some(needsSpeakerReview) && <p>Överlappande tal har markerats här. {selectedSpans.some((s) => !s.decision) ? "Talaren behöver granskas." : "Talarbeslutet ändrar inte den ursprungliga överlappsmarkeringen."}</p>}
      {selectedSpans.some((s) => s.decision === "unresolved") && <p>Granskad: talare går inte att avgöra.</p>}
      {reviews.some((r) => r.overlapDetection === "unavailable") && <p>Överlappningsanalys saknas för del {reviews.filter((r) => r.overlapDetection === "unavailable").map((r) => r.fileIndex + 1).join(", ")}.</p>}
      {reviews.some((r) => r.detailsOmitted) && <p>Överlappsdetaljer har utelämnats eftersom underlaget är för stort.</p>}
      {selection.flatMap((span) => (raw[span.segmentIndex].words ?? []).filter((w) => w.uncertain && w.charStart < span.end && w.charEnd > span.start &&
        !corrections.occurrences.some((o) => o.segment_index === span.segmentIndex && w.charStart < o.char_end && w.charEnd > o.char_start)).map((w) => {
          const key = wordKey(span.segmentIndex, w);
          return <p key={key}>Ordet “{w.word}” kunde inte hittas säkert i ljudet. {onToggleConfirmed && <button type="button" className="underline" onClick={() => onToggleConfirmed(key)}>{confirmedWords.has(key) ? "Ångra ordbekräftelse" : "Bekräfta att ordet stämmer"}</button>}</p>;
        }))}
      <details className="mt-2"><summary className="min-h-6 cursor-pointer">Överlapp i inspelningen</summary><ul className="mt-2 space-y-1">{reviews.flatMap((r) => r.overlaps).map((o) => <li key={`${o.fileIndex}:${o.id}`}><button type="button" className="underline" disabled={!audioAvailable} onClick={() => { onSeek(o.fileIndex, Math.max(0, o.start - 1.5), true); onInteract(); }}>Del {o.fileIndex + 1}, {formatClock(o.start)}–{formatClock(o.end)}</button> · {o.detectedSpeakerCount} modellröster</li>)}</ul></details>
    </section>
    <p className="px-5 pt-4 text-[12px] text-ink-mute" id={helpId}><span className="transcript-focus-label font-medium">Transkript</span>. Klicka på ett understruket ord för att flytta uppspelningen. Starta med playknappen. {textEditable && "Skriv direkt i texten för att rätta den. "}Prickade passager markeras för granskning. Dra över ord för att markera en del.<span className="sr-only"> Använd Skift och piltangenter för att markera ord. Alt+T flyttar fokus till verktygen. Tab går vidare och Escape avmarkerar. Rätta text med knappen Rätta text.</span></p>
    {!shown.length && <p className="px-5 py-4 text-[13px] text-ink-mute">Inga transkriptord finns. Använd Nästa för att lyssna på markerade överlapp.</p>}
    {reviews.some((r) => r.overlapDetection === "unavailable") && <p className="px-5 pt-2 text-[12px] text-ink-mute">Överlappningsanalys saknas. Se Detaljer.</p>}
    {reviews.some((r) => r.detailsOmitted) && <p className="px-5 pt-2 text-[12px] text-ink-mute">Överlappsdetaljer har utelämnats eftersom underlaget är för stort.</p>}
    <div ref={body} className="transcript-editor-text px-5 py-5 sm:px-7 outline-none focus:outline-none" onMouseUp={captureSelection} onTouchEnd={captureSelection} onKeyUp={captureSelection}
      onFocusCapture={(e) => { if (e.target !== body.current) { const target = e.target; requestAnimationFrame(() => target.scrollIntoView({ block: "nearest", behavior: "instant" })); } }}
      contentEditable suppressContentEditableWarning role="textbox" aria-label="Transkript, markera ord för att redigera" aria-multiline="true" aria-readonly={!textEditable} aria-describedby={helpId} aria-keyshortcuts="Alt+T" tabIndex={0}
      onCopy={(e) => { if (selection.length && window.getSelection()?.isCollapsed) { e.preventDefault(); e.clipboardData.setData("text/plain", selectedText); } }}
      onPaste={(e) => { e.preventDefault(); typeText(e.clipboardData.getData("text/plain")); }}
      onCut={(e) => { e.preventDefault(); const native = window.getSelection(); if (native && !native.isCollapsed) { e.clipboardData.setData("text/plain", native.toString()); typeText(""); } }} onDrop={(e) => e.preventDefault()}
      onKeyDown={(e) => { e.stopPropagation();
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (textEditable && undoAvailable && !e.shiftKey) { onChange?.({ ...corrections, occurrences: undo!.before.occurrences, speaker_edits: undo!.before.speaker_edits }); setUndo(null); setNotice("Ändringen är ångrad."); }
          return;
        }
        if (e.altKey && (e.code === "KeyT" || e.key.toLowerCase() === "t")) { e.preventDefault(); focusTools(); }
        if (e.key === "Escape" && selection.length) { e.preventDefault(); setSelection([]); setEditing(false); window.getSelection()?.collapseToEnd(); } }}>
      {paragraphs.map((indices, paragraphIndex) => {
        const textIndices = indices.filter((i) => shown[i].text.trim());
        if (!textIndices.length) return null;
        const first = shown[textIndices[0]];
        const suggested = first.modelSpeaker === undefined ? first.speaker : first.modelSpeaker;
        const same = textIndices.every((i) => shown[i].speaker === first.speaker && shown[i].decision !== "unresolved");
        const certain = same && textIndices.every((i) => !needsSpeakerReview(shown[i]) || shown[i].decision === "confirmed");
        const name = certain ? displayName(first.speaker) : same && suggested ? `Förslag: ${displayName(suggested)}` : [...new Set(textIndices.map((i) => shown[i].decision === "unresolved" ? "Oavgjord" : needsSpeakerReview(shown[i]) && !shown[i].decision ? `Förslag: ${displayName(shown[i].speaker)}` : displayName(shown[i].speaker)))].join(", ");
        return <div key={paragraphIndex} data-turn-index={paragraphIndex} data-caret-paragraph={paragraphIndex === caretParagraph ? "true" : undefined} className="mb-6 pl-2 grid grid-cols-1 gap-1 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-4">
          <div contentEditable={false} className="flex min-w-0 items-start gap-2 text-[11px] sm:block sm:pt-1">
            <button type="button" disabled={!audioAvailable} className="inline-flex min-h-6 min-w-6 shrink-0 items-center text-ink-mute hover:text-ink tabular-nums disabled:opacity-40" onClick={() => { onSeek(first.fileIndex, first.start, false); onInteract(); }} aria-label={`Flytta uppspelningen till ${formatClock(first.start)}`}>{raw.some((s) => s.fileIndex > 0) ? `Del ${first.fileIndex + 1} · ` : ""}{formatClock(first.start)}</button>
            <button type="button" className="block min-h-6 min-w-6 max-w-full whitespace-normal text-left font-medium [overflow-wrap:anywhere] sm:mt-1" style={{ color: tint(certain ? first.speaker : null) }} aria-label={`Markera stycket: ${name}`} onClick={() => choose(anchorTextSelection(indices.map((i) => ({ index: i, start: 0, end: shown[i].text.length })), shown, corrections))}>{name}</button>
          </div>
          <p className="min-w-0 max-w-[68ch] [overflow-wrap:anywhere] whitespace-pre-wrap text-[16px] leading-[1.95] text-ink selection:bg-primary/30">{indices.map((index, i) => {
            const segment = shown[index], previous = i > 0 ? shown[indices[i - 1]] : null;
            const sameSource = previous && segment.sourceSegmentIndex !== undefined && segment.sourceSegmentIndex === previous.sourceSegmentIndex;
            const precedingTextIndex = indices.slice(0, i).reverse().find((n) => shown[n].text.trim());
            const precedingText = precedingTextIndex === undefined ? null : shown[precedingTextIndex];
            const changed = segment.text.trim() && precedingText && (precedingText.speaker !== segment.speaker || precedingText.decision !== segment.decision && segment.decision === "unresolved");
            return <span key={index}>{previous && !sameSource ? " " : ""}{changed && <span contentEditable={false} className="mx-1 inline-block max-w-full whitespace-normal rounded bg-bg-2 px-1.5 align-baseline text-[12px] font-medium leading-5 [overflow-wrap:anywhere]" style={{ color: tint(segment.decision === "unresolved" ? null : segment.speaker) }}>{segment.decision === "unresolved" ? "Oavgjord" : needsSpeakerReview(segment) && !segment.decision ? `Förslag: ${displayName(segment.modelSpeaker === undefined ? segment.speaker : segment.modelSpeaker)}` : displayName(segment.speaker)}</span>}{textSpan(segment, index)}</span>;
          })}</p>
        </div>;
      })}
    </div>
  </div>;
}
