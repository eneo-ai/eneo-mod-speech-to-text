import { speakerMappingReviewSteps, type RunContract } from "./api";
import type { InputMode } from "./flow-session";
import { selectRuntimeInputStep } from "./upload";

/**
 * Whether the flow's result is text rather than a document: exactly when Eneo gives it back in the run (delivery
 * "payload"), which the result view shows. A file, a result sent on to a receiver, and an Eneo or flow that does not
 * say are a document.
 */
export function makesText(output: Pick<NonNullable<RunContract["final_output"]>, "delivery"> | null | undefined): boolean {
  return output?.delivery === "payload";
}

/** The heading of the sending and of the running view, which carry on under one another: by what the flow ends in. */
export function creatingHeading(text: boolean): string {
  return text ? "Texten skapas" : "Dokumentet skapas";
}

/** The action that makes the run, by what the flow ends in (`makesText`). */
export function createActionLabel(text: boolean): string {
  return text ? "Skapa text" : "Skapa dokument";
}

/** The last line of "Så fungerar det": by how the contract says the result is delivered, never by what the flow makes. */
const DELIVERY_LINE = {
  payload: "Du får texten att läsa och kopiera.",
  artifact: "Du får ett dokument att ladda ner.",
  outbound_http: "Resultatet skickas vidare till en mottagare.",
} as const;

/** The first line of "Så fungerar det": [the audio is asked for, the audio is offered], by the ways in the device has. */
const WAY_IN = {
  both: ["Du spelar in eller laddar upp ljud.", "Du kan spela in eller ladda upp ljud."],
  record: ["Du spelar in ljudet.", "Du kan spela in ljudet."],
  upload: ["Du laddar upp en ljudfil.", "Du kan ladda upp en ljudfil."],
} as const;

/**
 * Where the flow's result goes on to a receiver: said beside the action that sends the run (the setup's, the recording's
 * Skapa dokument), never only in the folded overview. Null for a result the person gets here.
 */
export function forwardedLine(contract: Pick<RunContract, "final_output"> | null | undefined): string | null {
  return contract?.final_output?.delivery === "outbound_http" ? DELIVERY_LINE.outbound_http : null;
}

/** What the setup tells before the first choice: the steps the person meets, and what helps the sound. */
export interface HowItWorks {
  steps: string[];
  tips: string[];
}

/**
 * "Så fungerar det" for a flow, derived from its run contract and the ways in the device offers, so whoever builds the
 * flow writes nothing. A step is only said when the contract states it: no time, no storage period. Null where the
 * flow takes no audio (no way in, or a file that is not sound).
 */
export function howItWorks(contract: RunContract, modes: readonly InputMode[]): HowItWorks | null {
  const input = selectRuntimeInputStep(contract);
  if (modes.length === 0 || input?.input_format?.toLowerCase() !== "audio") return null;
  const records = modes.some((mode) => mode !== "ladda-upp");
  const uploads = modes.includes("ladda-upp");
  const asksWhoIsWho = speakerMappingReviewSteps(contract).length > 0;
  const delivery = contract.final_output?.delivery;
  // Audio the flow can run without is offered, not asked for.
  const [asked, offered] = WAY_IN[records && uploads ? "both" : records ? "record" : "upload"];
  const steps = [
    input.required === false ? offered : asked,
    ...(contract.transcription ? ["Ljudet görs om till text."] : []),
    ...(asksWhoIsWho ? ["Du bekräftar vem som är vem."] : []),
    (delivery && DELIVERY_LINE[delivery]) ?? "Du får resultatet här när flödet är klart.",
  ];
  const tips = records
    ? [
        ...(asksWhoIsWho ? ["Be alla säga sitt namn i början. Det hjälper när du bekräftar vem som är vem."] : []),
        "Ställ en enhet mitt på bordet.",
        "Stäng dörrar och fönster om du kan.",
        "Lås inte skärmen under inspelningen.",
      ]
    : [];
  return { steps, tips };
}
