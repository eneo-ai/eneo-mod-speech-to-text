"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
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

// The selector takes no empty value; Standard is "" everywhere else.
const STANDARD = "standard";

/**
 * The microphone and "Testa mikrofonen", an optional check before recording.
 * The microphone is asked for only when the user presses the button; until
 * the browser allows it, the picker offers only "Standard", and afterwards
 * every microphone by name. The chosen device is remembered and used when
 * recording starts; one that is gone falls back to Standard, and says so.
 */
export function MicrophoneCheck({ active }: { active: boolean }) {
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

  const status = stream ? (heard ? "Mikrofonen hör dig." : "Säg något för att se att mikrofonen hör dig.") : "";
  return (
    <VStack gap={3}>
      {/* Beside each other where there is room; the test below the picker where there is not. */}
      <HStack gap={3} wrap="wrap" align="end">
        <Selector
          label="Mikrofon"
          options={choices.map((choice) => ({ value: choice.value || STANDARD, label: choice.label }))}
          value={value || STANDARD}
          onChange={(next) => choose(next === STANDARD ? "" : next)}
          presentation="adaptive"
          // Below the picker, not over it: the default puts the open list on the picker, hiding the control that has focus.
          placement="below"
          description={missing ? "Den valda mikrofonen hittades inte. Standard används." : undefined}
          width="min(100%, 24rem)"
        />
        <Button
          label={stream ? "Sluta testa" : "Testa mikrofonen"}
          variant="secondary"
          icon={<Icon icon="microphone" />}
          onClick={() => (stream ? setStream(null) : void test())}
        />
      </HStack>
      {stream && <LevelMeter stream={stream} bars={24} variant="steps" className="h-6" />}
      {/* Always rendered, so a screen reader hears the change once; the same words are for the eye while it is tested. */}
      <VisuallyHidden as="p" role="status">
        {status}
      </VisuallyHidden>
      {stream && (
        <Text as="p" type="supporting" aria-hidden>
          {status}
        </Text>
      )}
      {problem && <ProblemAlert problem={problem} onRetry={() => void test()} />}
    </VStack>
  );
}
