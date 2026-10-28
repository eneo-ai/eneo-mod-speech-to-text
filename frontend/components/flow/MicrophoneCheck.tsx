import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { LevelMeter, readyInputLevel, useInputLevel } from "@/components/flow/LevelMeter";
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
/** What to do before the meeting, and what the test does with the sound (it only measures the level; nothing is kept or
 *  sent), in one line across the section on a laptop. Under the picker's label, and the same words whatever the browser
 *  knows of its microphones, so nothing under it moves when it names them: choosing is the picker's own label. */
const BEFORE = "Testa mikrofonen före mötet. Testet spelas inte in och skickas inte.";
/** The status line's words before a test, and between tests with nothing to say: what the line is for. */
const RESTING = "Testet visar här om mikrofonen hör dig.";
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
export function MicrophoneCheck({ active, tips = [] }: { active: boolean; /** Tips for good sound (`howItWorks`), folded under the test. */ tips?: readonly string[] }) {
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
    readyInputLevel();
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

  // What the test says, with an icon for a verdict, so it is not told by colour alone: heard, or quiet (nothing heard, or
  // the microphone gone). Waiting words have none.
  const status: { words: string; verdict?: "heard" | "quiet" } = stream
    ? muted
      ? { words: AWAY, verdict: "quiet" }
      : heard
        ? { words: "Mikrofonen hör dig.", verdict: "heard" }
        : { words: "Säg något för att se att du hörs." }
    : askingLong
      ? { words: ASK_THE_BROWSER }
      : tested
        ? heard
          ? { words: "Mikrofonen hörde dig.", verdict: "heard" }
          : {
              words: `Mikrofonen hörde inget. Kontrollera att den inte är avstängd${choosable ? ", eller välj en annan i listan" : ""}.`,
              verdict: "quiet",
            }
        : { words: RESTING };

  // One section under the way that records: the picker across it, then the test beside the level it drives, then what the
  // test says, on a line of its own, so words of another length never move the level or the button.
  return (
    <VStack gap={3} className={styles.microphone}>
      {/* Its list is a popover, as the page's other overlays are covered with it when the login ends: the touch screen's
          bottom sheet is a modal dialog of its own, which would stay above the covered page. */}
      <Selector
        label="Mikrofon"
        options={choices.map((choice) => ({ value: choice.value || STANDARD, label: choice.label }))}
        value={value || STANDARD}
        onChange={(next) => choose(next === STANDARD ? "" : next)}
        description={missing ? `Den valda mikrofonen hittades inte. Standard används. ${BEFORE}` : BEFORE}
        width="100%"
      />
      {/* Beside each other from 30 rem; narrower, the test takes the row, as the phone's other actions do, and the level
          the row under it. The level rests in its place from the first draw, unlit, so a test that starts moves nothing. */}
      <HStack gap={4} wrap="wrap" vAlign="center">
        <StackItem className={styles.test}>
          <Button label={testing ? STOP : TEST} variant="secondary" width="100%" onClick={() => (testing ? stopTest() : void test())}>
            {/* As wide with either word, so it does not shrink under the finger that pressed it: the icon and the word
                shown, centred together, over the other word's, hidden. */}
            <span className={styles.sameWidth}>
              <span>
                <Icon icon={testing ? "stop" : "microphone"} />
                {testing ? STOP : TEST}
              </span>
              <span aria-hidden>
                <Icon icon={testing ? "microphone" : "stop"} />
                {testing ? TEST : STOP}
              </span>
            </span>
          </Button>
        </StackItem>
        <LevelMeter stream={stream} bars={40} variant="steps" even className={styles.meter} />
      </HStack>
      {/* Always rendered, so a screen reader hears each change once. */}
      <HStack as="p" role="status" gap={2} vAlign="center">
        {status.verdict === "heard" && <Icon icon="success" color="success" size="sm" />}
        {status.verdict === "quiet" && <Icon icon="warning" color="warning" size="sm" />}
        <Text type="supporting" color={status.verdict ? "primary" : "secondary"} textWrap="pretty">
          {status.words}
        </Text>
      </HStack>
      {problem && <ProblemAlert problem={problem} onRetry={() => void test()} />}
      {/* By the test, where the sound is thought of before the meeting, and only with a way that records. */}
      {tips.length > 0 && (
        <Collapsible trigger="Tips för bra ljud" defaultIsOpen={false}>
          <VStack as="ul" gap={2} className={styles.tips}>
            {tips.map((tip) => (
              <li key={tip}>
                <Text>{tip}</Text>
              </li>
            ))}
          </VStack>
        </Collapsible>
      )}
    </VStack>
  );
}
