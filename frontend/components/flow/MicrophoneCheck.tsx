"use client";

import { Mic } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LevelMeter, useInputLevel } from "@/components/flow/LevelMeter";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { browserStorage, microphoneProblem, type Problem } from "@/lib/flow-session";
import { SPEECH_RECORDING } from "@/lib/recording-session";
import {
  audioConstraints,
  listMicrophones,
  microphonePermission,
  preferredMicrophone,
  setPreferredMicrophone,
} from "@/lib/microphone";

/**
 * "Testa mikrofonen": an optional check before recording. The microphone is
 * asked for only when the user presses the button; once the browser allows
 * it, the device picker shows at once and a test never asks again. The chosen
 * device is remembered and used when recording starts.
 */
export function MicrophoneCheck({ active }: { active: boolean }) {
  const selectId = useId();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [heard, setHeard] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // A test granted after recording started, or after the page went, lets go at once.
  const allowed = useRef(active);

  useEffect(() => {
    let cancelled = false;
    setDeviceId(preferredMicrophone(browserStorage()) ?? "");
    const refresh = () => void listMicrophones().then((found) => !cancelled && setDevices(found));
    void microphonePermission().then((state) => state === "granted" && refresh());
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

  async function test(id = deviceId) {
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
      setDevices(await listMicrophones());
    } catch (error) {
      setProblem(microphoneProblem(error instanceof DOMException ? error.name : null));
    }
  }

  function choose(id: string) {
    setPreferredMicrophone(browserStorage(), id);
    setDeviceId(id);
    if (stream) void test(id);
  }

  const chosen = devices.some((device) => device.deviceId === deviceId) ? deviceId : "";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {devices.length > 1 ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <label htmlFor={selectId} className="shrink-0 text-[15px] text-ink-soft">
              Mikrofon:
            </label>
            <select
              id={selectId}
              value={chosen}
              onChange={(event) => choose(event.target.value)}
              className="h-11 min-w-0 flex-1 truncate rounded-xl border border-rule bg-paper px-3 text-[15px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <option value="">Standard</option>
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </div>
        ) : devices.length === 1 ? (
          <p className="min-w-0 flex-1 truncate text-[15px] text-ink-soft">Mikrofon: {devices[0].label}</p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => (stream ? setStream(null) : void test())}
        >
          <Mic data-icon="inline-start" aria-hidden />
          {stream ? "Sluta testa" : "Testa mikrofonen"}
        </Button>
      </div>
      {stream && <LevelMeter stream={stream} bars={24} variant="steps" className="h-6" />}
      {/* Always rendered, so a screen reader hears the change once. */}
      <p role="status" className={stream ? "text-[13px] text-ink-soft" : "sr-only"}>
        {stream ? (heard ? "Mikrofonen hör dig." : "Säg något för att se att mikrofonen hör dig.") : ""}
      </p>
      {problem && <ProblemAlert problem={problem} onRetry={() => void test()} />}
    </div>
  );
}
