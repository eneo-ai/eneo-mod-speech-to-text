import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { LevelMeter, useInputLevel } from "@/components/flow/LevelMeter";
import { ProblemAlert } from "@/components/flow/ProblemAlert";
import { microphoneProblem, type Problem } from "@/lib/flow-session";
import { browserStorage } from "@/lib/browser-storage";
import { SPEECH_RECORDING } from "@/lib/recording-session";
import styles from "./FlowSetup.module.css";
import {
  audioConstraints,
  listMicrophones,
  microphoneChoices,
  preferredMicrophone,
  setPreferredMicrophone,
} from "@/lib/microphone";

// The picker takes no empty value; Standard is "" everywhere else.
const STANDARD = "standard";
const TEST = "Testa mikrofonen";
const STOP = "Sluta testa";
/** When to test, and what the test does with the sound (it only measures the level; nothing is kept or sent). Under the
 *  picker's label, so it stands still whatever the test is doing. Which microphone to pick is said only when the list
 *  has more than one (`choosable`): the browser names its microphones once one has been allowed. */
const before = (choosable: boolean) =>
  `Testa innan mötet börjar${choosable ? " och välj den mikrofon som sitter närmast talarna" : ""}. Det du säger under testet spelas inte in och skickas inte vidare.`;
/** The browser's question about the microphone left unanswered for a moment: the same words as the start's (FlowInput). */
const ASK_THE_BROWSER = "Svara på frågan i webbläsaren.";
/** A muted track while it is tested: the recording's own words for it (lib/recording-view). Each status is one line on
 *  the narrowest phone, so a change of words moves nothing under them; Sluta testa says that the test goes on. */
const AWAY = "Mikrofonen är tillfälligt borta.";
/** An answer within this leaves no words to blink (the page's --module-wait-delay). */
const ASK_DELAY_MS = 300;
/** A test left running lets the microphone go by itself after this, so the browser's microphone light goes out. */
const TEST_LIMIT_MS = 60_000;

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
  // The browser is asked for the microphone and has not answered: the test is under way and can be stopped.
  const [asking, setAsking] = useState(false);
  const [askingLong, setAskingLong] = useState(false);
  // The tested microphone's track is muted (a headset changing its route, the system's mute): what it heard is no longer so.
  const [muted, setMuted] = useState(false);
  // A test ran and has ended: what it heard is said until the next test or another microphone.
  const [tested, setTested] = useState(false);
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
  // A test forgotten, or left for another tab or the home screen, lets go of the microphone by itself.
  useEffect(() => {
    if (!stream) return;
    const timer = setTimeout(stopTest, TEST_LIMIT_MS);
    const hidden = () => document.hidden && stopTest();
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [stream]);
  useEffect(() => {
    if (!asking) {
      setAskingLong(false);
      return;
    }
    const timer = setTimeout(() => setAskingLong(true), ASK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [asking]);
  useEffect(() => {
    allowed.current = active;
    if (!active) {
      request.current += 1;
      setStream(null);
      setAsking(false);
    }
    return () => {
      allowed.current = false;
      request.current += 1;
    };
  }, [active]);

  // Heard on this read's own level, not the display's gliding one: after a moment muted, only new sound counts.
  useInputLevel(stream, (_level, running, _peak, now) => {
    if (running && now > 0.35 && !muted) setHeard(true);
  });

  const { choices, value, missing } = microphoneChoices(inputs, preferred);
  // Standard and the microphone it names are one: a choice needs a second microphone.
  const choosable = choices.length > 2;
  const testing = stream !== null || asking;

  // The same choice recording makes: the remembered microphone, asked for as `ideal`.
  async function test(id = preferred ?? "") {
    const mine = (request.current += 1);
    setProblem(null);
    setHeard(false);
    // Another microphone's test lets the one before go at once: what that one hears must not pass for this one.
    setStream(null);
    setMuted(false);
    setTested(false);
    setAsking(true);
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(id || null, { channelCount: SPEECH_RECORDING.channelCount }),
      });
      if (!allowed.current || mine !== request.current) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      // A microphone that goes (unplugged, taken by another app) ends the test; a muted one is heard again only once it is
      // back and sound comes: nothing it said before holds.
      for (const track of next.getAudioTracks()) {
        track.addEventListener("ended", () => mine === request.current && stopTest({ verdict: false }), { once: true });
        track.addEventListener("mute", () => {
          if (mine !== request.current) return;
          setMuted(true);
          setHeard(false);
        });
        track.addEventListener("unmute", () => mine === request.current && setMuted(false));
      }
      setStream(next);
      setTested(true);
      setInputs(await listMicrophones());
    } catch (error) {
      // A test that was ended, or replaced, has no error to show.
      if (mine === request.current) setProblem(microphoneProblem(error instanceof DOMException ? error.name : null));
    } finally {
      if (mine === request.current) setAsking(false);
    }
  }

  /**
   * Sluta testa: the stream goes, and a request still waiting for the browser is overtaken. What the test heard is said
   * after it (`verdict`), except for a microphone that went: nothing it said holds.
   */
  function stopTest({ verdict = true } = {}) {
    request.current += 1;
    setStream(null);
    setAsking(false);
    setMuted(false);
    if (!verdict) setTested(false);
  }

  function choose(id: string) {
    setPreferredMicrophone(browserStorage(), id);
    setPreferred(id || null);
    // What the last test heard was another microphone's.
    setTested(false);
    // A test under way, or waiting for the browser, goes on with the microphone now chosen.
    if (stream || asking) void test(id);
  }

  return (
    <VStack gap={2}>
      {/* Beside each other where there is room; on a phone the picker fills the row and the test stands under it
          (FlowSetup.module.css sets the width by the row's width). */}
      <HStack gap={3} wrap="wrap" align="end" className={styles.microphoneRow}>
        {/* Its list is a popover, as the page's other overlays are covered with it when the login ends: the touch screen's
            bottom sheet is a modal dialog of its own, which would stay above the covered page. */}
        <Selector
          label="Mikrofon"
          options={choices.map((choice) => ({ value: choice.value || STANDARD, label: choice.label }))}
          value={value || STANDARD}
          onChange={(next) => choose(next === STANDARD ? "" : next)}
          description={missing ? `Den valda mikrofonen hittades inte. Standard används. ${before(choosable)}` : before(choosable)}
          width="var(--microphone-picker-width, min(100%, 24rem))"
        />
        <Button label={testing ? STOP : TEST} variant="secondary" onClick={() => (testing ? stopTest() : void test())}>
          {/* As wide with either word, so it does not shrink under the finger that pressed it: the icon and the word
              shown, centred together, over the other word's, hidden. */}
          <span className={styles.sameWidth}>
            <span>
              <Icon icon="microphone" />
              {testing ? STOP : TEST}
            </span>
            <span aria-hidden>
              <Icon icon="microphone" />
              {testing ? TEST : STOP}
            </span>
          </span>
        </Button>
      </HStack>
      {/* The level and what it says have their place from the first draw, so a test that starts moves nothing under
          them (the start's button on a tablet or a laptop); the bars rest until it does. The bars take their height
          from the row they stand in. The words have a line of their own under the bars: beside them, on a phone, a
          longer one dropped to a row of its own and a shorter one came back, and what stood under them moved. */}
      <VStack gap={1}>
        <HStack height={24}>
          <LevelMeter stream={stream} bars={24} variant="steps" />
        </HStack>
        {/* Always rendered, with a line's height when it says nothing, so a screen reader hears the change once. */}
        <Text as="p" role="status" type="supporting">
          {stream
            ? muted
              ? AWAY
              : heard
                ? "Mikrofonen hör dig."
                : "Säg något för att se att du hörs."
            : askingLong
              ? ASK_THE_BROWSER
              : tested
                ? heard
                  ? "Mikrofonen hörde dig."
                  : `Mikrofonen hörde inget. Kontrollera att den inte är avstängd${choosable ? ", eller välj en annan i listan" : ""}.`
                : " "}
        </Text>
      </VStack>
      {problem && <ProblemAlert problem={problem} onRetry={() => void test()} />}
    </VStack>
  );
}
