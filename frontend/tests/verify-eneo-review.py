"""Read synthetic Lyssna cases on stdin; validate with Eneo's actual API/domain."""
import json
import sys

from eneo.flows.api.flow_models import FlowTranscriptCorrectionsEditRequest
from eneo.flows.domain.transcript_corrections import (
    TranscriptCorrectionOccurrence,
    TranscriptSpeakerEdit,
    apply_to_rendered_transcript,
    validate_occurrences,
    validate_speaker_edits,
)
from eneo.flows.domain.transcript_words import locate_words

cases = json.load(sys.stdin)
for case in cases:
    request = FlowTranscriptCorrectionsEditRequest.model_validate(case["request"])
    occurrences = [TranscriptCorrectionOccurrence(**item.model_dump()) for item in request.occurrences]
    edits = [TranscriptSpeakerEdit(**item.model_dump()) for item in request.speaker_edits]
    validate_occurrences(case["segments"], occurrences)
    validate_speaker_edits(case["segments"], edits)
    words = {i: locate_words(segment["text"], segment["words"]) for i, segment in enumerate(case["segments"])}
    rendered = apply_to_rendered_transcript(case["raw"], case["segments"], occurrences, edits, words)
    assert rendered == case["expected"], (case["name"], rendered, case["expected"])
print(f"{len(cases)} Lyssna v3 requests and exports match Eneo API validation and rendering.")
