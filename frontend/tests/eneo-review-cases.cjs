// Pipe this output to verify-eneo-review.py inside the Eneo devcontainer.
const t = require('../.test-build/lib/transcript.js');
const c = require('../.test-build/lib/transcript-corrections.js');
const cases = [];
for (const text of ['ett två tre', '🙂 två tre']) {
  const input = { file_index: 0, start: 0, end: 3, text, speaker: 'SPEAKER_00', speaker_attribution: 'provisional', overlap_ids: ['file:overlap_0000'], words: [] };
  input.words = text.split(' ').map((word, i) => ({ word, start: i, end: i + 1 }));
  const segments = t.segmentsFromTranscription({ segments: [input] });
  const base = { ...c.EMPTY_CORRECTIONS, schemaVersion: 3, segmentsHash: 'a'.repeat(64) };
  const start = text.indexOf('två'), end = start + 3;
  const confirmed = c.withSpeakerDecision(base, segments, 0, start, end, 'confirmed', 'SPEAKER_01');
  const unresolved = c.withSpeakerDecision(base, segments, 0, start, end, 'unresolved', null);
  const edited = c.withLineCorrection(unresolved, 0, { segment_index: 0, char_start: start, char_end: end, original: 'två', corrected: 'andra' });
  const undone = c.withSpeakerDecision(confirmed, segments, 0, null, null, null, null);
  for (const [name, set] of Object.entries({ confirmed, unresolved, edited, undone })) cases.push({ name: `${text}:${name}`, segments: [input], raw: c.renderReviewedTranscript(segments, base), request: c.correctionRequest(set, segments), expected: c.renderReviewedTranscript(segments, set) });
}
const fixtures = require('./fixtures/speaker_review.json');
for (const fixture of fixtures.cases) {
  const raw = fixture.result.segments.map((s) => ({ ...s, file_index: 0 }));
  const segments = t.segmentsFromTranscription({ ...fixture.result, segments: raw });
  const base = { ...c.EMPTY_CORRECTIONS, schemaVersion: 3, segmentsHash: 'a'.repeat(64) };
  const target = Math.max(0, segments.findIndex((s) => s.speakerAttribution === 'provisional'));
  const confirmed = c.withSpeakerDecision(base, segments, target, null, null, 'confirmed', segments[target].speaker ?? 'SPEAKER_00');
  const unresolved = c.withSpeakerDecision(base, segments, target, null, null, 'unresolved', null);
  const undone = c.withSpeakerDecision(confirmed, segments, target, null, null, null, null);
  for (const [name, set] of Object.entries({ confirmed, unresolved, undone })) cases.push({ name: `${fixture.name}:${name}`, segments: raw, raw: c.renderReviewedTranscript(segments, base), request: c.correctionRequest(set, segments), expected: c.renderReviewedTranscript(segments, set) });
}
process.stdout.write(JSON.stringify(cases));
