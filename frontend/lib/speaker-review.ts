import type { FlowRunStep } from "./api";
import { needsSpeakerReview, segmentsFromTranscription, type TranscriptSegment } from "./transcript";

/** Review controls are opt-in; evidence is always preserved. */
export const SPEAKER_REVIEW_ENABLED = process.env.NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED === "true";

export interface SpeechOverlap {
  id: string;
  fileIndex: number;
  start: number;
  end: number;
  detectedSpeakerCount: number;
}
export interface FileSpeakerReview {
  fileIndex: number;
  version: number;
  overlapDetection: "available" | "unavailable";
  overlaps: SpeechOverlap[];
  detailsOmitted?: boolean;
}
export const overlapKey = (fileIndex: number, id: string): string => JSON.stringify([fileIndex, id]);

/** Single Vemsa result or file-scoped Eneo records. Never combine local IDs. */
export function speakerReviewsFromTranscription(value: unknown): FileSpeakerReview[] {
  if (!value || typeof value !== "object") return [];
  const meta = value as Record<string, unknown>;
  const review = meta.speaker_review as { files?: unknown; details_omitted_reason?: unknown } | null;
  const entries = Array.isArray(review?.files) ? review.files
    : Array.isArray(meta.speaker_review) ? meta.speaker_review : [meta.speaker_review];
  return entries.flatMap((value): FileSpeakerReview[] => {
    if (!value || typeof value !== "object") return [];
    const entry = value as Record<string, unknown>;
    const fileIndex = typeof entry.file_index === "number" ? entry.file_index : 0;
    const overlaps = (Array.isArray(entry.overlaps) ? entry.overlaps : []).flatMap((value): SpeechOverlap[] => {
      if (!value || typeof value !== "object") return [];
      const o = value as Record<string, unknown>;
      if (typeof o.id !== "string" || typeof o.start !== "number" || typeof o.end !== "number" ||
          !Number.isFinite(o.start) || !Number.isFinite(o.end) || o.start < 0 || o.end <= o.start ||
          typeof o.detected_speaker_count !== "number" || o.detected_speaker_count < 2) return [];
      return [{ id: o.id, fileIndex, start: o.start, end: o.end, detectedSpeakerCount: o.detected_speaker_count }];
    });
    return [{ fileIndex, detailsOmitted: Boolean(review?.details_omitted_reason), version: typeof entry.version === "number" ? entry.version : 0,
      overlapDetection: entry.version === 1 && entry.overlap_detection === "available" ? "available" : "unavailable", overlaps }];
  });
}

/** The transcription a step result's input carries, as the transcription step stores it. */
export function stepTranscription(step: FlowRunStep | undefined): unknown {
  return (step?.input_payload_json as { transcription?: unknown } | null | undefined)?.transcription;
}

/** A step result that holds a transcript: its segments, or at least its speaker review. */
export function carriesTranscript(step: FlowRunStep | undefined): boolean {
  const transcription = stepTranscription(step);
  return segmentsFromTranscription(transcription) !== null || speakerReviewsFromTranscription(transcription).length > 0;
}

export interface ReviewPassage {
  key: string;
  fileIndex: number;
  start: number;
  end: number;
  segmentIndex: number | null;
}

/** Unreviewed spans plus overlap intervals without transcript words. */
export function reviewPassages(segments: readonly TranscriptSegment[], reviews: readonly FileSpeakerReview[]): ReviewPassage[] {
  const passages = segments.flatMap((s, i): ReviewPassage[] => needsSpeakerReview(s) && !s.decision && Boolean(s.text.trim())
    ? [{ key: `segment:${i}`, fileIndex: s.fileIndex, start: s.start, end: s.end, segmentIndex: i }] : []);
  for (const review of reviews) for (const overlap of review.overlaps) {
    if (!segments.some((s) => s.fileIndex === overlap.fileIndex && s.start < overlap.end && s.end > overlap.start && s.text.trim())) {
      passages.push({ key: overlapKey(overlap.fileIndex, overlap.id), fileIndex: overlap.fileIndex,
        start: overlap.start, end: overlap.end, segmentIndex: null });
    }
  }
  return passages.sort((a, b) => a.fileIndex - b.fileIndex || a.start - b.start);
}
