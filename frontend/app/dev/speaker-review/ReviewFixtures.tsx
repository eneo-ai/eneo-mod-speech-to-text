"use client";
import { useEffect, useState } from "react";
import fixtures from "@/tests/fixtures/speaker_review.json";
import { SpeakerMappingEditor } from "@/components/SpeakerMappingEditor";
import type { SpeakerMappingRow } from "@/lib/speaker-mapping";
import { TranscriptPlayer } from "@/components/TranscriptPlayer";
import { locateWords, segmentsFromTranscription } from "@/lib/transcript";
import { speakerReviewsFromTranscription } from "@/lib/speaker-review";
import { EMPTY_CORRECTIONS, type CorrectionSet } from "@/lib/transcript-corrections";

export function ReviewFixtures() {
  const [selected, setSelected] = useState("overlap");
  const [audio, setAudio] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [names, setNames] = useState<SpeakerMappingRow[]>(Array.from({ length: 6 }, (_, i) => ({
    label: `SPEAKER_0${i}`, name: i === 0 ? "programledare/intervjuare" : `Deltagare ${i + 1}`, lineCount: 1,
    confidence: "medium", evidence: "Syntetiskt namnförslag för tillgänglighetskontroll.", samples: [],
  })));
  const [url, setUrl] = useState("");
  const [drafts, setDrafts] = useState<Record<string, CorrectionSet>>({});
  useEffect(() => {
    // Four seconds of synthetic silence, solely to exercise the media element.
    const bytes = new ArrayBuffer(44 + 8000 * 4 * 2);
    const view = new DataView(bytes);
    const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVEfmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, bytes.byteLength - 44, true);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    setUrl(objectUrl); return () => URL.revokeObjectURL(objectUrl);
  }, []);
  const fixture = fixtures.cases.find((c) => c.name === selected)?.result ?? fixtures.cases.find((c) => c.name === "wordless-unknown")!.result;
  let segments = segmentsFromTranscription(fixture) ?? [];
  let reviews = speakerReviewsFromTranscription(fixture);
  let corrections: CorrectionSet = { ...EMPTY_CORRECTIONS, schemaVersion: 3, segmentsHash: "a".repeat(64) };
  if (selected === "operator" || selected === "long-names" || selected === "bulk") {
    const texts = ["Nu har vi pratat ganska länge om det här och jag har skrivit ut den här", "långtidsprognosen som vi ska läsa", "tillsammans imorgon. Det är bara", "den där. Behåll den där, Agne. Behåll den där, du."];
    segments = texts.map((text, i) => ({ fileIndex: 0, start: i * 0.8, end: (i + 1) * 0.8, text,
      speaker: i === 3 ? "SPEAKER_01" : "SPEAKER_00", modelSpeaker: i === 3 ? "SPEAKER_01" : "SPEAKER_00",
      speakerAttribution: i === 1 || selected === "bulk" ? "provisional" as const : "assigned" as const, overlapIds: i === 1 || selected === "bulk" ? ["example"] : [],
      words: locateWords(text, text.split(" ").map((word, n, all) => ({ word, start: i * 0.8 + n / all.length * 0.8, end: i * 0.8 + (n + 1) / all.length * 0.8 })), null),
    }));
    reviews = [{ fileIndex: 0, version: 1, overlapDetection: "available", overlaps: [{ id: "example", fileIndex: 0, start: 0.8, end: 1.6, detectedSpeakerCount: 2 }] }];
  }
  if (selected === "accessibility") {
    segments = names.map((row, i) => ({ fileIndex: 0, start: i * .5, end: (i + 1) * .5,
      text: i === 2 ? "EttsammansattordSomÄrTillräckligtLångtFörAttTestaRadbrytningVidHögFörstoringOchSmalSkärm." : `Här talar deltagare ${i + 1}. Nästa mening fortsätter med samma talare.`,
      speaker: row.label, modelSpeaker: row.label, speakerAttribution: "assigned" as const,
    }));
    reviews = [];
  }
  if (selected === "wordless") segments = [];
  if (selected === "two-files") {
    segments = [...segments, ...segments.map((s) => ({ ...s, fileIndex: 1 }))];
    reviews = [...reviews, ...reviews.map((r) => ({ ...r, fileIndex: 1, overlaps: r.overlaps.map((o) => ({ ...o, fileIndex: 1 })) }))];
  }
  if (selected === "partial") {
    corrections = { ...corrections, speaker_edits: [{ segment_index: 0, char_start: 4, char_end: 7, original: segments[0].text.slice(4, 7), original_speaker: null, speaker: "SPEAKER_01", decision: "confirmed" }] };
  }
  return <main className="mx-auto w-full max-w-4xl p-6">
    <h1 className="text-2xl font-semibold">Talargranskning – testfall</h1>
    <p>Endast syntetiska testdata. Testljudet är tyst och verifierar inte talet.</p>
    <label className="my-4 block">Testfall <select aria-label="Testfall" value={selected} onChange={(e) => setSelected(e.target.value)} className="border p-2">
      {[...fixtures.cases.map((c) => c.name), "wordless", "two-files", "partial", "operator", "long-names", "bulk", "accessibility"].map((value) => <option key={value}>{value}</option>)}
    </select></label>
    <label className="mb-4 block"><input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} /> Tillgängligt testljud</label>
    <label className="mb-4 block"><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> Skrivskyddat</label>
    {selected === "accessibility" && <details className="paper-card mb-3 p-4"><summary className="min-h-6 cursor-pointer">Talare</summary>
      <div className="mt-4"><SpeakerMappingEditor rows={names} proposals={names} participants={Array.from({ length: 20 }, (_, i) => `Testperson ${i + 1} Efternamn`)} onChange={setNames} disabled={readOnly} /></div>
    </details>}
    <TranscriptPlayer key={`${selected}:${audio}`} segments={segments} speakerReviews={reviews} reviewEnabled
      fileCount={audio ? selected === "two-files" ? 2 : 1 : 0} audioSrcFor={() => url}
      speakerNames={selected === "accessibility" ? Object.fromEntries(names.map((row) => [row.label, row.name ?? row.label])) : selected === "long-names" ? { SPEAKER_00: "programledare/intervjuare", SPEAKER_01: "IntervjupersonMedEttMycketLångtSammanhängandeNamn" } : (selected === "operator" || selected === "bulk") ? { SPEAKER_00: "Agne", SPEAKER_01: "Karin" } : {}} textFallback="" corrections={drafts[selected] ?? corrections} editable={!readOnly} speakerOptions={selected === "accessibility" ? names.map((r) => r.label) : ["SPEAKER_00", "SPEAKER_01"]}
      onCorrectionsChange={(next) => setDrafts((prev) => ({ ...prev, [selected]: next }))} className="paper-card" />
  </main>;
}
