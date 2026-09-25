import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import type { FlowPublished, FlowRunPublic, FlowRunReviewCheckpointPublic, ReviewEditedValue } from "./api";
import { button, cleanup, installDom, mount, type } from "./test-dom";

installDom();
afterEach(async () => {
  await cleanup();
  window.sessionStorage.clear();
});

const PAUSE = "/api/eneo/flows/flow-1/runs/run-1/review-checkpoints/cp-1/";
const pause: FlowRunReviewCheckpointPublic = {
  id: "cp-1",
  flow_id: "flow-1",
  flow_run_id: "run-1",
  step_id: "step-2",
  step_order: 2,
  attempt_no: 1,
  schema_version: 1,
  state: "awaiting_review",
  revision: 1,
  review_mode: "edit",
  output_type: "text",
  step_label: "Sammanfattning",
  created_at: "2026-09-24T09:00:00Z",
  updated_at: "2026-09-24T09:00:00Z",
  current_payload_json: { text: "Utkast från flödet." },
};

/** Eneo's pause, with the edit's answer held until `release`, and approval failing (503); with `approves`, the
 * approval goes through and the resume after it fails. */
function eneo(t: { after: (fn: () => void) => void }, { approves = false } = {}) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let current = pause;
  const calls: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(url), "http://module.test").pathname;
    const method = init.method ?? "GET";
    if (method === "PATCH" && path === PAUSE) {
      calls.push("edit");
      await held;
      const body = JSON.parse(String(init.body));
      current = { ...current, revision: current.revision + 1, current_payload_json: { text: body.edited_value } };
      return json(200, current);
    }
    if (method === "POST" && path === `${PAUSE}approve/`) {
      calls.push("approve");
      if (!approves) return json(503, { code: "upstream_unreachable" });
      current = { ...current, state: "approved", revision: current.revision + 1 };
      return json(200, current);
    }
    if (method === "POST" && path === `${PAUSE}resume/`) {
      calls.push("resume");
      return json(503, { code: "upstream_unreachable" });
    }
    if (path.endsWith("/review-checkpoints/active/")) return json(200, current);
    return json(404, { detail: `stub: ${method} ${path}` });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return { calls, release };
}

// The same pause at the "who is who" step: the speakers to name, and the transcript beside them.
const speakers: FlowRunReviewCheckpointPublic = {
  ...pause,
  output_type: "json",
  step_label: "Talare",
  current_payload_json: {
    speaker_mapping: { inventory: [{ label: "SPEAKER_00", line_count: 3 }, { label: "SPEAKER_01", line_count: 2 }] },
    structured: { speakers: [{ label: "SPEAKER_00", name: "Anna Berg", confidence: "high", evidence: "" }] },
  },
};

const rejected: string[] = [];

/** The review on the page; with `saves`, Spara ändring goes through and the page holds the saved text. */
async function review(start = pause, { saves = false } = {}) {
  const { createElement, useState } = await import("react");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { AuthenticatedUserContext } = await import("../components/AuthGate");
  const { ReviewView } = await import("../components/flow/ReviewView");
  const { continueFromPause } = await import("./review-continue");
  const router = { push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined } as unknown as import("next/dist/shared/lib/app-router-context.shared-runtime").AppRouterInstance;
  const run = { id: "run-1", flow_id: "flow-1", status: "awaiting_review" } as FlowRunPublic;
  const published = { id: "flow-1", name: "Nämndmöte till rapport", published_version: 3 } as FlowPublished;
  // The page's own wiring: the pause's newer states reach the view, a failure says why.
  function Page() {
    const [checkpoint, setCheckpoint] = useState(start);
    return createElement(ReviewView, {
      flowId: "flow-1",
      published,
      checkpoint,
      runState: { run, steps: [] },
      runError: null,
      onContinue: async (cp: FlowRunReviewCheckpointPublic, edit: ReviewEditedValue | null, options?: { onSaved?: () => void }) => {
        try {
          await continueFromPause({ flowId: "flow-1", runId: "run-1", checkpoint: cp, edit, onCheckpoint: setCheckpoint, onHeld: options?.onSaved });
          return null;
        } catch {
          return "Servern kunde inte nås just nu. Försök igen om en stund.";
        }
      },
      onSaveEdit: async (cp: FlowRunReviewCheckpointPublic, value: ReviewEditedValue) => {
        if (!saves) return { error: "unused" };
        const saved = { ...cp, revision: cp.revision + 1, current_payload_json: { text: value as string } };
        setCheckpoint(saved);
        return saved;
      },
      onReject: async () => {
        rejected.push("reject");
        throw new Error("503");
      },
    });
  }
  return mount(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(AuthenticatedUserContext.Provider, { value: { id: "user-1", email: "anna@example.se" } }, createElement(Page)),
    ),
  );
}

test("while Spara och fortsätt is under way the text cannot change, so nothing typed then is lost when the save's answer drops the draft", async (t) => {
  const server = eneo(t);
  const view = await review();
  await view.act(async () => button(view.container, "Redigera")!.click());
  const field = () => view.container.querySelector("textarea")!;
  await view.act(async () => type(field(), "First edit"));

  let going!: Promise<void>;
  await view.act(async () => {
    button(view.container, "Spara och fortsätt")!.click();
    going = new Promise((resolve) => setTimeout(resolve, 0));
  });
  await view.act(async () => going);
  assert.deepEqual(server.calls, ["edit"], "the save is under way, its answer held");
  assert.equal(field().readOnly, true, "the text is locked while it is being sent");
  assert.equal(button(view.container, "Avbryt")?.disabled ?? true, true);
  await view.act(async () => type(field(), "Second edit typed while waiting."));
  assert.equal(field().value, "First edit", "no second edit slips in under the save");

  await view.act(async () => {
    server.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(server.calls, ["edit", "approve"], "saved, then the approval failed");
  assert.equal(field().value, "First edit", "what was sent is what the pause now holds, and what the page shows");
  assert.equal(field().readOnly, false, "editable again once nothing is under way");
});

test("the save's answer drops only the draft of the version it sent, never a newer one", async () => {
  const { createElement } = await import("react");
  const { useReviewDraft } = await import("../components/useReviewDraft");
  let draft!: ReturnType<typeof useReviewDraft<{ text: string }>>;
  function Holder() {
    draft = useReviewDraft<{ text: string }>("user-1", "review:run-1:cp-1", 1);
    return null;
  }
  const view = await mount(createElement(Holder));
  await view.act(async () => void draft.keep({ text: "Second edit typed while waiting." }));
  await view.act(async () => draft.drop({ text: "First edit" }));
  assert.deepEqual(draft.initial, { text: "Second edit typed while waiting." }, "a newer edit than the one sent stays");
  await view.act(async () => draft.drop({ text: "Second edit typed while waiting." }));
  assert.equal(draft.initial, null, "the version that was sent goes");
});

test("a rejection cannot start while Spara och fortsätt is under way, nor end its lock", async (t) => {
  rejected.length = 0;
  const server = eneo(t);
  const view = await review();
  await view.act(async () => button(view.container, "Redigera")!.click());
  const field = () => view.container.querySelector("textarea")!;
  await view.act(async () => type(field(), "First edit"));
  await view.act(async () => button(view.container, "Avvisa")!.click());
  const reason = () => [...view.container.querySelectorAll("textarea")].find((el) => el !== field())!;
  await view.act(async () => type(reason(), "Fel möte."));

  await view.act(async () => {
    button(view.container, "Spara och fortsätt")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.deepEqual(server.calls, ["edit"], "the save is under way");
  const confirm = button(view.container, "Bekräfta avvisning")!;
  assert.equal(confirm.disabled, true, "no second mutation while one is in flight");
  await view.act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.deepEqual(rejected, [], "the rejection did not start");
  assert.equal(field().readOnly, true, "still locked: only the save's own end unlocks it");
  await view.act(async () => type(field(), "Newer text."));

  await view.act(async () => {
    server.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(server.calls, ["edit", "approve"]);
  assert.equal(field().value, "First edit", "what went is what was on screen when it was sent");
});


test("the pause's view takes the focus on its heading, so a screen reader starts there", async (t) => {
  eneo(t);
  for (const [start, name] of [[pause, "Sammanfattning"], [speakers, "Vem är vem?"]] as const) {
    const view = await review(start);
    const focused = document.activeElement;
    assert.ok(focused?.tagName === "H1" && focused.textContent === name, `focus on ${focused?.tagName} "${focused?.textContent}"`);
    assert.equal(document.title, `${name} · Tal till text`);
    await view.unmount();
  }
});

test("a control that removes or disables itself hands the focus on, never to the page", async (t) => {
  eneo(t);
  const view = await review(pause, { saves: true });
  const press = (name: string) =>
    view.act(async () => {
      const control = button(view.container, name)!;
      control.focus();
      control.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const focused = () => document.activeElement;
  await press("Avvisa");
  assert.ok(focused()?.matches('textarea[placeholder="Skäl …"]'), `Avvisa: the reason, not ${focused()?.tagName}`);
  await press("Avbryt");
  assert.ok(focused() === button(view.container, "Avvisa"), `Avbryt: back on Avvisa, not ${focused()?.tagName}`);

  const redigera = button(view.container, "Redigera")!;
  await press("Redigera");
  assert.equal(redigera.isConnected, false, "Redigera is not reused as Avbryt, which a second Enter would press");
  assert.ok(focused() === view.container.querySelector("textarea"), `Redigera: the text, not ${focused()?.tagName}`);
  await press("Avbryt");
  assert.ok(focused() === button(view.container, "Redigera"), `Avbryt: back on Redigera, not ${focused()?.tagName}`);
  await press("Redigera");
  await view.act(async () => type(view.container.querySelector("textarea")!, "Utkast som granskats."));
  await press("Spara ändring");
  assert.equal(view.container.querySelector("textarea"), null, "saved");
  assert.ok(focused() === button(view.container, "Redigera"), `Spara ändring: on Redigera, not ${focused()?.tagName}`);
});

test("who is who: Avvisa and Godkänn och fortsätt sit in the speaker card under Namnge talarna, before the transcript", async (t) => {
  eneo(t);
  const view = await review(speakers);
  const card = button(view.container, "Namnge talarna")!.closest("details")!;
  const approve = button(view.container, "Godkänn och fortsätt")!;
  assert.ok(card.contains(approve) && card.contains(button(view.container, "Avvisa")));
  assert.equal(approve.closest(".sticky"), null, "not docked over the transcript");
  await view.act(async () => button(view.container, "Avvisa")!.click());
  assert.ok(card.contains(button(view.container, "Bekräfta avvisning")), "the reason form opens there too");
  const transcript = view.container.querySelector('section[aria-label="Transkript"], section[aria-label="Inspelning och transkript"]')!;
  assert.ok(approve.compareDocumentPosition(transcript) & window.Node.DOCUMENT_POSITION_FOLLOWING, "before the transcript");
});

test("an approved pause is final: a reason typed before approving cannot reject it, also when the resume failed", async (t) => {
  rejected.length = 0;
  const server = eneo(t, { approves: true });
  const view = await review();
  await view.act(async () => button(view.container, "Avvisa")!.click());
  await view.act(async () => type(view.container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Skäl …"]')!, "Fel möte."));
  await view.act(async () => {
    button(view.container, "Godkänn och fortsätt")!.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.deepEqual(server.calls, ["approve", "resume"], "approved, then the resume failed");
  assert.ok(button(view.container, "Fortsätt"), "the one way on is Fortsätt");
  // Booleans: a failed comparison of a DOM node makes node print it, which takes minutes under jsdom.
  assert.ok(!button(view.container, "Bekräfta avvisning"), "no rejection of an approved pause");
  assert.ok(!view.container.querySelector('textarea[placeholder="Skäl …"]'), "no reason form");
  assert.ok(!button(view.container, "Avvisa"), "no Avvisa");
  assert.deepEqual(rejected, []);
});
