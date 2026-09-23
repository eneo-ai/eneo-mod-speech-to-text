"use client";

import { Mic } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LevelMeter, useInputLevel } from "@/components/flow/LevelMeter";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { browserStorage, microphoneProblem, type Problem } from "@/lib/flow-session";
import { SPEECH_RECORDING } from "@/lib/recording-session";
import {
  audioConstraints,
  listMicrophones,
  microphoneChoices,
  preferredMicrophone,
  setPreferredMicrophone,
} from "@/lib/microphone";

// Radix Select takes no empty value; Standard is "" everywhere else.
const STANDARD = "standard";

/**
 * The microphone and "Testa mikrofonen", an optional check before recording.
 * The microphone is asked for only when the user presses the button; until
 * the browser allows it, the picker offers only "Standard", and afterwards
 * every microphone by name. The chosen device is remembered and used when
 * recording starts; one that is gone falls back to Standard, and says so.
 */
export function MicrophoneCheck({ active }: { active: boolean }) {
  const selectId = useId();
  const noteId = useId();
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [heard, setHeard] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // A test granted after recording started, or after the page went, lets go at once.
  const allowed = useRef(active);

  useEffect(() => {
    let cancelled = false;
    setPreferred(preferredMicrophone(browserStorage()));
    const refresh = () => void listMicrophones().then((found) => !cancelled && setInputs(found));
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  // The test lets go of the microphone when it ends, when recording starts and when the page goes.
  useEffect(() => () => stream?.getTracks().forEach((track) => track.stop()), [stream]);
  useEffect(() => {
    allowed.current = active;
    if (!active) setStream(null);
    return () => {
      allowed.current = false;
    };
  }, [active]);

  useInputLevel(stream, (level, running) => {
    if (running && level > 0.35) setHeard(true);
  });

  const { choices, value, missing } = microphoneChoices(inputs, preferred);

  // The same choice recording makes: the remembered microphone, asked for as `ideal`.
  async function test(id = preferred ?? "") {
    setProblem(null);
    setHeard(false);
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(id || null, { channelCount: SPEECH_RECORDING.channelCount }),
      });
      if (!allowed.current) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      setStream(next);
      setInputs(await listMicrophones());
    } catch (error) {
      setProblem(microphoneProblem(error instanceof DOMException ? error.name : null));
    }
  }

  function choose(id: string) {
    setPreferredMicrophone(browserStorage(), id);
    setPreferred(id || null);
    if (stream) void test(id);
  }

  return (
    <div className="flex flex-col gap-3">
      <Field className="gap-2">
        <FieldLabel htmlFor={selectId} className="text-[15px] font-semibold text-ink">
          Mikrofon
        </FieldLabel>
        {/* Beside each other on a laptop; the test below the picker on a phone. */}
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <Select value={value || STANDARD} onValueChange={(next) => choose(next === STANDARD ? "" : next)}>
            <SelectTrigger id={selectId} aria-describedby={missing ? noteId : undefined} className="min-w-0 sm:flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((choice) => (
                <SelectItem key={choice.value || STANDARD} value={choice.value || STANDARD}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0"
            onClick={() => (stream ? setStream(null) : void test())}
          >
            <Mic data-icon="inline-start" aria-hidden />
            {stream ? "Sluta testa" : "Testa mikrofonen"}
          </Button>
        </div>
        {missing && (
          <FieldDescription id={noteId} className="text-[13px]">
            Den valda mikrofonen hittades inte. Standard används.
          </FieldDescription>
        )}
      </Field>
      {stream && <LevelMeter stream={stream} bars={24} variant="steps" className="h-6" />}
      {/* Always rendered, so a screen reader hears the change once. */}
      <p role="status" className={stream ? "text-[13px] text-ink-soft" : "sr-only"}>
        {stream ? (heard ? "Mikrofonen hör dig." : "Säg något för att se att mikrofonen hör dig.") : ""}
      </p>
      {problem && <ProblemAlert problem={problem} onRetry={() => void test()} />}
    </div>
  );
}
