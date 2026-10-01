"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
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

// The picker takes no empty value; Standard is "" everywhere else.
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
  // The newest request for the microphone. A request that a later one, Sluta testa or the page has overtaken is stale:
  // the microphone it is granted is let go at once, never turned on (RecordingCapture's generation, in a component).
  const request = useRef(0);

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
    if (!active) {
      request.current += 1;
      setStream(null);
    }
    return () => {
      allowed.current = false;
      request.current += 1;
    };
  }, [active]);

  useInputLevel(stream, (level, running) => {
    if (running && level > 0.35) setHeard(true);
  });

  const { choices, value, missing } = microphoneChoices(inputs, preferred);

  // The same choice recording makes: the remembered microphone, asked for as `ideal`.
  async function test(id = preferred ?? "") {
    const mine = (request.current += 1);
    setProblem(null);
    setHeard(false);
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(id || null, { channelCount: SPEECH_RECORDING.channelCount }),
      });
      if (!allowed.current || mine !== request.current) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      setStream(next);
      setInputs(await listMicrophones());
    } catch (error) {
      // A test that was ended, or replaced, has no error to show.
      if (mine === request.current) setProblem(microphoneProblem(error instanceof DOMException ? error.name : null));
    }
  }

  /** Sluta testa: the stream goes, and a request still waiting for the browser is overtaken. */
  function stopTest() {
    request.current += 1;
    setStream(null);
  }

  function choose(id: string) {
    setPreferredMicrophone(browserStorage(), id);
    setPreferred(id || null);
    if (stream) void test(id);
  }

  return (
    <VStack gap={2}>
      {/* Beside each other where there is room; the test below the picker where there is not. */}
      <HStack gap={3} wrap="wrap" align="end">
        {/* Its list is a popover, as the page's other overlays are covered with it when the login ends: the touch screen's
            bottom sheet is a modal dialog of its own, which would stay above the covered page. */}
        <Selector
          label="Mikrofon"
          options={choices.map((choice) => ({ value: choice.value || STANDARD, label: choice.label }))}
          value={value || STANDARD}
          onChange={(next) => choose(next === STANDARD ? "" : next)}
          description={missing ? "Den valda mikrofonen hittades inte. Standard används." : undefined}
          width="min(100%, 24rem)"
        />
        <Button
          label={stream ? "Sluta testa" : "Testa mikrofonen"}
          variant="secondary"
          icon={<Icon icon="microphone" />}
          onClick={() => (stream ? stopTest() : void test())}
        />
      </HStack>
      {/* The bars take their height from the row they stand in. */}
      {stream && (
        <HStack height={24}>
          <LevelMeter stream={stream} bars={24} variant="steps" />
        </HStack>
      )}
      {/* Always rendered, so a screen reader hears the change once. */}
      <Text as="p" role="status" type="supporting">
        {stream ? (heard ? "Mikrofonen hör dig." : "Säg något för att se att mikrofonen hör dig.") : ""}
      </Text>
      {problem && <ProblemAlert problem={problem} onRetry={() => void test()} />}
    </VStack>
  );
}
