import assert from "node:assert/strict";
import test from "node:test";

import { button, installDom, mount, type } from "./test-dom";

installDom();

test("participants: moving from the field to Lägg till and on keeps the typed name", async () => {
  const { createElement } = await import("react");
  const { ParticipantsInput } = await import("../components/flow/ParticipantsInput");
  const changes: string[][] = [];
  const outside = document.createElement("button");
  document.body.append(outside);
  const view = await mount(
    createElement(ParticipantsInput, { id: "namn", names: [], onChange: (names: string[]) => changes.push(names), suggestions: [] }),
  );
  const field = view.container.querySelector<HTMLInputElement>("#namn")!;
  await view.act(async () => field.focus());
  await view.act(async () => type(field, "Anna Berg"));
  const add = button(view.container, "Lägg till")!;
  assert.ok(add, "Lägg till shows while a name is typed");
  // Tab to the button: not yet added, the button adds it.
  await view.act(async () => add.focus());
  assert.deepEqual(changes, []);
  // Tab on past it: the name is not lost.
  await view.act(async () => outside.focus());
  assert.deepEqual(changes, [["Anna Berg"]]);
  await view.unmount();
  outside.remove();
});

test("participants: Tab to Lägg till and Enter adds the name, and focus goes back to the field", async () => {
  const { createElement } = await import("react");
  const { ParticipantsInput } = await import("../components/flow/ParticipantsInput");
  const changes: string[][] = [];
  const view = await mount(
    createElement(ParticipantsInput, { id: "namn2", names: [], onChange: (names: string[]) => changes.push(names), suggestions: [] }),
  );
  const field = view.container.querySelector<HTMLInputElement>("#namn2")!;
  await view.act(async () => field.focus());
  await view.act(async () => type(field, "Erik Lund"));
  const add = button(view.container, "Lägg till")!;
  await view.act(async () => add.focus());
  await view.act(async () => add.click());
  assert.deepEqual(changes, [["Erik Lund"]], "added once");
  assert.equal(document.activeElement, field);
  await view.unmount();
});

async function mountEditableTranscript(onChange: (next: unknown) => void) {
  const { createElement } = await import("react");
  const { TranscriptPlayer } = await import("../components/TranscriptPlayer");
  const view = await mount(
    createElement(TranscriptPlayer, {
      segments: [
        { fileIndex: 0, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna till mötet." },
        { fileIndex: 0, start: 2, end: 4, speaker: "SPEAKER_01", text: "Tack, vi börjar." },
      ],
      fileCount: 0,
      audioSrcFor: () => "",
      speakerNames: {},
      textFallback: "",
      reviewEnabled: false,
      editable: true,
      corrections: { occurrences: [], speaker_edits: [], revision: null },
      onCorrectionsChange: onChange,
    }),
  );
  await view.act(async () => button(view.container, "Rätta repliken från 0:00")!.click());
  const editor = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Rätta repliken från 0:00"]')!;
  assert.ok(editor, "the line editor is open");
  await view.act(async () => type(editor, "Välkomna allihop."));
  return { view, editor };
}

test("transcript: Tab to Avbryt and activate it leaves the text as it was", async () => {
  const changes: unknown[] = [];
  const { view } = await mountEditableTranscript((next) => changes.push(next));
  const cancel = button(view.container, "Avbryt")!;
  await view.act(async () => cancel.focus());
  assert.deepEqual(changes, [], "moving to the editor's own buttons saves nothing");
  assert.ok(button(view.container, "Avbryt"), "the editor stays open");
  await view.act(async () => cancel.click());
  assert.deepEqual(changes, []);
  assert.equal(view.container.querySelector("textarea"), null, "closed, unchanged");
  await view.unmount();
});

test("transcript: Tab to Spara and activate it saves once; leaving the editor saves too", async () => {
  const saved: unknown[] = [];
  const { view } = await mountEditableTranscript((next) => saved.push(next));
  const save = button(view.container, "Spara")!;
  await view.act(async () => save.focus());
  assert.deepEqual(saved, []);
  await view.act(async () => save.click());
  assert.equal(saved.length, 1);
  await view.unmount();

  const left: unknown[] = [];
  const outside = document.createElement("button");
  document.body.append(outside);
  const again = await mountEditableTranscript((next) => left.push(next));
  await again.view.act(async () => outside.focus());
  assert.equal(left.length, 1, "focus leaving the whole editor saves the edit");
  await again.view.unmount();
  outside.remove();
});

test("a choice field keeps every option Eneo sends, also one that reads like 'no choice'", async () => {
  const { createElement } = await import("react");
  const { DetailsForm } = await import("../components/flow/DetailsForm");
  const changes: [string, unknown][] = [];
  const mountWith = (value: string) =>
    mount(
      createElement(DetailsForm, {
        fields: [{ name: "svar", label: "Svar", type: "select", options: ["inget-val", "Ja", "opt:0"], required: false }],
        details: { svar: value },
        invalid: [],
        onChange: (name: string, next: unknown) => changes.push([name, next]),
        suggestions: [],
        onNamesAdded: () => {},
      }),
    );
  const open = async (view: Awaited<ReturnType<typeof mountWith>>) => {
    const trigger = view.container.querySelector<HTMLButtonElement>("#detalj-svar")!;
    await view.act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  };

  const chosen = await mountWith("inget-val");
  assert.equal(chosen.container.querySelector("#detalj-svar")?.textContent?.trim(), "inget-val", "the chosen option, not 'no choice'");
  assert.deepEqual((await open(chosen)).map((option) => option.textContent?.trim()), ["Inget val", "inget-val", "Ja", "opt:0"]);
  await chosen.unmount();

  // Choosing each one hands back its own value, and "Inget val" the empty one.
  for (const [start, label, expected] of [
    ["", "opt:0", "opt:0"],
    ["", "Ja", "Ja"],
    ["", "inget-val", "inget-val"],
    ["Ja", "Inget val", ""],
  ] as const) {
    const view = await mountWith(start);
    const option = (await open(view)).find((o) => o.textContent?.trim() === label)!;
    await view.act(async () => {
      option.focus();
      option.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.deepEqual(changes.at(-1), ["svar", expected], label);
    await view.unmount();
  }
});

test("the microphone test uses the device recording will use, and shows it, also before the names are known", async () => {
  const { createElement } = await import("react");
  const { MicrophoneCheck } = await import("../components/flow/MicrophoneCheck");
  let allowed = false;
  const asked: MediaStreamConstraints[] = [];
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
      enumerateDevices: async () =>
        [
          ["default", "Standard – MacBook Pro-mikrofon", "g1"],
          ["mac", "MacBook Pro-mikrofon", "g1"],
          ["usb", "Jabra Speak 510", "g2"],
        ].map(([deviceId, label, groupId]) => ({
          kind: "audioinput",
          deviceId: allowed ? deviceId : "",
          label: allowed ? label : "",
          groupId,
        })),
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        asked.push(constraints);
        allowed = true;
        return { getTracks: () => [{ stop() {} }], getAudioTracks: () => [] };
      },
    },
  });
  localStorage.setItem("tal-till-text:microphone", "usb");
  const view = await mount(createElement(MicrophoneCheck, { active: true }));
  const trigger = () => view.container.querySelector<HTMLButtonElement>('[role="combobox"]')!.textContent?.trim();
  assert.equal(trigger(), "Senast vald mikrofon", "the remembered choice, before the browser names it");

  await view.act(async () => button(view.container, "Testa mikrofonen")!.click());
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual((asked[0].audio as MediaTrackConstraints).deviceId, { ideal: "usb" }, "as recording asks for it");
  assert.equal(trigger(), "Jabra Speak 510", "the device under test, by name");
  await view.unmount();
  localStorage.clear();
});

test("upload: the whole drop zone opens the file chooser, the chooser knows the flow's extensions, and the zone is no extra Tab stop", async () => {
  const { createElement, createRef } = await import("react");
  const { UploadPanel } = await import("../components/flow/UploadPanel");
  const inputRef = createRef<HTMLInputElement>();
  const chosen: string[] = [];
  const step = { step_id: "step-doc", input_format: "document", accepted_mimetypes: ["text/markdown", "application/pdf"] };
  const view = await mount(
    createElement(UploadPanel, { step, file: null, audio: false, inputRef, onChoose: (file: File) => chosen.push(file.name) }),
  );
  const input = inputRef.current!;
  let opened = 0;
  input.addEventListener("click", () => (opened += 1));

  const zone = view.container.querySelector<HTMLElement>("[data-drop-zone]")!;
  await view.act(async () => zone.querySelector("span")!.click());
  assert.equal(opened, 1, "a click anywhere on the zone opens the chooser");
  assert.equal(input.accept, "text/markdown,.md,.markdown,application/pdf,.pdf");
  assert.equal(zone.tabIndex, -1, "the zone takes no focus: the primary button is the one keyboard stop");
  assert.equal(input.tabIndex, -1);

  Object.defineProperty(input, "files", { value: [new File(["# Plan"], "underlag.md")], configurable: true });
  await view.act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  assert.deepEqual(chosen, ["underlag.md"]);
  await view.unmount();
});

/** A page's router and signed-in user, as the app gives them. */
async function signedIn(element: import("react").ReactElement, navigated: string[]) {
  const { createElement } = await import("react");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { AuthenticatedUserContext } = await import("../components/AuthGate");
  const go = (href: string) => void navigated.push(href);
  const router = { push: go, replace: go, prefetch: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined } as unknown as import("next/dist/shared/lib/app-router-context.shared-runtime").AppRouterInstance;
  const user = { id: "user-1", email: "anna@example.se", username: "Anna" };
  return createElement(AppRouterContext.Provider, { value: router }, createElement(AuthenticatedUserContext.Provider, { value: user }, element));
}

const exits = (container: HTMLElement) => ({
  links: container.querySelectorAll('a[href="/flows"]').length,
  account: [...container.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label")?.startsWith("Öppna konto")).length,
});

test("upload under way: the header offers no way off the page, which would abort the upload unasked; Avbryt is the way out", async () => {
  const { createElement } = await import("react");
  const { SubmittingView } = await import("../components/flow/SubmittingView");
  const navigated: string[] = [];
  let cancelled = 0;
  const published = { id: "flow-6", name: "Genomförandeplan IBIC", published_version: 2 } as import("./api").FlowPublished;
  const submission = { kind: "uploading", filename: "underlag.pdf", loaded: 0, total: 2048, percent: 0, wait: null } as const;
  const view = await mount(
    await signedIn(createElement(SubmittingView, { published, submission, onCancelSubmission: () => (cancelled += 1) }), navigated),
  );
  assert.deepEqual(exits(view.container), { links: 0, account: 0 }, "no back link, no brand link, no sign-out while it uploads");

  await view.act(async () => button(view.container, "Avbryt")!.click());
  assert.equal(cancelled, 1);
  assert.deepEqual(navigated, []);
  await view.unmount();
});

test("recording: the account menu steps aside for the mode on every width, so sign-out cannot drop the recording", async () => {
  const { createElement } = await import("react");
  const { FlowTopBar } = await import("../components/flow/FlowTopBar");
  const view = await mount(await signedIn(createElement(FlowTopBar, { title: "Nämndmöte", trailing: "Spelar in" }), []));
  assert.deepEqual(exits(view.container), { links: 2, account: 0 }, "the links stay, asked through onLeave");
  await view.unmount();
});

test("the way back: a link to the flow list named Alla flöden, and a leave guard still decides first", async () => {
  const { createElement } = await import("react");
  const { BackToFlows } = await import("../components/flow/BackToFlows");
  const asked: boolean[] = [];
  const view = await mount(
    await signedIn(
      createElement(BackToFlows, {
        onLeave: (event: import("react").MouseEvent) => {
          event.preventDefault();
          asked.push(true);
        },
      }),
      [],
    ),
  );
  const links = [...view.container.querySelectorAll("a")];
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "/flows");
  assert.equal(links[0].textContent?.trim(), "Alla flöden");

  const click = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  await view.act(async () => void links[0].dispatchEvent(click));
  assert.deepEqual(asked, [true], "the guard is asked");
  assert.equal(click.defaultPrevented, true, "and can keep the page");
  await view.unmount();
});

test("the phone top bar's back chevron is named like every other way back", async () => {
  const { createElement } = await import("react");
  const { FlowTopBar } = await import("../components/flow/FlowTopBar");
  const view = await mount(await signedIn(createElement(FlowTopBar, { title: "Nämndmöte" }), []));
  const chevron = view.container.querySelector('header a[aria-label]');
  assert.equal(chevron?.getAttribute("aria-label"), "Alla flöden");
  await view.unmount();
});

test("Back during an upload asks first and says what leaving stops", async () => {
  const { createElement } = await import("react");
  const { useLeaveQuestion } = await import("../components/flow/useLeaveQuestion");
  const { leaveWarning } = await import("./recording-view");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  function Page() {
    // A file on its way: the page holds no audio.
    return useLeaveQuestion(true, leaveWarning(true, "setup", true)).question;
  }
  const view = await mount(await signedIn(createElement(Page), []));
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  await view.act(async () => {
    window.history.back();
    await settle();
  });
  assert.match(dialog()?.textContent ?? "", /Lämna sidan\?/);
  assert.match(dialog()?.textContent ?? "", /Sändningen avbryts/);
  await view.act(async () => button(dialog()!, "Stanna kvar")!.click());
  assert.equal(dialog(), null);
  await view.unmount();
});

test("signed out, Back still asks in a dialog that is shown, focused and answerable, outside the covered page", async () => {
  const { createElement } = await import("react");
  const { useLeaveQuestion } = await import("../components/flow/useLeaveQuestion");
  const { SignedOutCover } = await import("../components/AuthGate");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  function Recording() {
    return useLeaveQuestion(true, "Det som spelats in finns kvar bland osända inspelningar.").question;
  }
  await settle(); // the history step the last test's guard took back
  const view = await mount(await signedIn(createElement(SignedOutCover, { signedOut: true, children: createElement(Recording) }), []));
  await view.act(async () => {
    window.history.back();
    await settle();
  });
  const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  assert.ok(dialog, "asked");
  // Booleans only: a failed comparison of DOM nodes makes node print them, which takes minutes under jsdom.
  assert.ok(!dialog.closest("[inert]"), "not in the covered page");
  assert.ok(dialog.contains(document.activeElement), "the focus is in the question");
  await view.act(async () => button(dialog, "Stanna kvar")!.click());
  assert.equal(document.body.querySelector('[role="alertdialog"]'), null, "and it can be answered");
  await view.unmount();
});

test("while leaving would lose typed work, the top bar's links and Logga ut ask first", async (t) => {
  const { createElement } = await import("react");
  const { LeaveContext, useLeaveQuestion } = await import("../components/flow/useLeaveQuestion");
  const { FlowTopBar } = await import("../components/flow/FlowTopBar");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const navigated: string[] = [];
  let loggedOut = 0;
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    loggedOut += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
  });
  function Review() {
    const leaving = useLeaveQuestion(true, "Det du har skrivit kunde inte sparas i webbläsaren och försvinner om du lämnar sidan.");
    return createElement(
      LeaveContext.Provider,
      { value: leaving },
      createElement(FlowTopBar, { title: "Sammanfattning", titleIsHeading: false }),
      leaving.question,
    );
  }
  await settle(); // the history step the last test's guard took back
  const view = await mount(await signedIn(createElement(Review), navigated));
  const asked = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');

  await view.act(async () => view.container.querySelector<HTMLAnchorElement>('a[aria-label="Alla flöden"]')!.click());
  assert.ok(asked(), "Alla flöden asks");
  assert.deepEqual(navigated, []);
  await view.act(async () => button(asked()!, "Stanna kvar")!.click());

  const account = [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.startsWith("Öppna konto"))!;
  await view.act(async () => {
    account.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await settle();
  });
  const logOut = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("Logga ut"))!;
  await view.act(async () => {
    logOut.click();
    await settle();
  });
  assert.ok(asked(), "Logga ut asks");
  assert.equal(loggedOut, 0, "not signed out yet");
  await view.act(async () => {
    button(asked()!, "Lämna sidan")!.click();
    await settle();
  });
  assert.equal(loggedOut, 1, "signed out once the user chose to leave");
  await view.unmount();
});

test("a review edit comes back on its revision; once the review changed it is neither applied nor lost, but waits as din version", async (t) => {
  t.after(() => window.sessionStorage.clear());
  const { createElement, useState } = await import("react");
  const { useReviewDraft } = await import("../components/useReviewDraft");
  type Edit = { text?: string };
  let draft = null as unknown as ReturnType<typeof useReviewDraft<Edit>>;
  let setRevision: (revision: number) => void = () => {};
  function Review({ start }: { start: number }) {
    const [revision, set] = useState(start);
    setRevision = set;
    draft = useReviewDraft<Edit>("user-1", "review:run-1:cp-1", revision);
    return null;
  }
  const first = await mount(createElement(Review, { start: 3 }));
  await first.act(async () => draft.keep({ text: "Min text" }));
  await first.unmount(); // a reload
  const again = await mount(createElement(Review, { start: 3 }));
  assert.deepEqual(draft.initial, { text: "Min text" }, "back on the revision it was made on");

  await again.act(async () => setRevision(4)); // the save was refused as out of date, and the latest came in
  assert.equal(draft.initial, null, "never applied to the latest by itself");
  assert.deepEqual(draft.yours, { text: "Min text" }, "but kept, as din version");
  await again.act(async () => draft.drop()); // nothing typed on the latest: nothing to throw away
  assert.deepEqual(draft.yours, { text: "Min text" }, "not lost by the editor becoming clean");
  await again.act(async () => draft.keep({ text: "Ny text på den senaste" }));
  await again.unmount();
  const later = await mount(createElement(Review, { start: 4 }));
  assert.deepEqual(draft.initial, { text: "Ny text på den senaste" });
  assert.deepEqual(draft.yours, { text: "Min text" }, "an edit of the latest does not replace din version");

  let taken: Edit | null = null;
  await later.act(async () => {
    taken = draft.takeYours();
    draft.keep(taken!); // the page puts it in the editor, as its current edit
  });
  assert.deepEqual(taken, { text: "Min text" });
  assert.equal(draft.yours, null, "taken");
  assert.deepEqual(draft.initial, { text: "Min text" });
  await later.act(async () => setRevision(5)); // refused again, before anything else was typed
  await later.act(async () => {
    draft.keep(draft.takeYours()!);
  });
  assert.equal(draft.yours, null, "taken straight from the refused save");
  assert.deepEqual(draft.initial, { text: "Min text" });
  await later.act(async () => setRevision(6));
  await later.act(async () => draft.dropYours());
  assert.equal(draft.yours, null, "Behåll den senaste lets it go");
  await later.unmount();
  assert.equal(window.sessionStorage.length, 0, "nothing left behind");
});

test("a review edit the browser will not keep is still the page's, through a refused save; its only kept copy is never removed first", async (t) => {
  t.after(() => window.sessionStorage.clear());
  const { createElement, useState } = await import("react");
  const { useReviewDraft } = await import("../components/useReviewDraft");
  type Edit = { text?: string };
  let draft = null as unknown as ReturnType<typeof useReviewDraft<Edit>>;
  let setRevision: (revision: number) => void = () => {};
  function Review({ start }: { start: number }) {
    const [revision, set] = useState(start);
    setRevision = set;
    draft = useReviewDraft<Edit>("user-1", "review:run-1:cp-9", revision);
    return null;
  }
  const storage = Object.getPrototypeOf(window.sessionStorage) as Storage;
  const setItem = storage.setItem;
  let refuse: (key: string) => boolean = () => true;
  storage.setItem = function (this: Storage, key: string, value: string) {
    if (refuse(key)) throw new DOMException("full", "QuotaExceededError");
    return setItem.call(this, key, value);
  };
  t.after(() => {
    storage.setItem = setItem;
  });

  // Nothing kept by the browser: the page still has the edit, also as din version after the review changed.
  const refused = await mount(createElement(Review, { start: 3 }));
  await refused.act(async () => void draft.keep({ text: "Min text" }));
  assert.deepEqual(draft.initial, { text: "Min text" });
  await refused.act(async () => setRevision(4));
  assert.deepEqual(draft.yours, { text: "Min text" }, "din version, from the page itself");
  await refused.unmount();
  window.sessionStorage.clear();

  // Only din version refused: its one kept copy (the older revision's edit) is not written over.
  refuse = (key) => key.endsWith(":din");
  const kept = await mount(createElement(Review, { start: 3 }));
  await kept.act(async () => void draft.keep({ text: "Min text" }));
  await kept.act(async () => setRevision(4));
  await kept.act(async () => void draft.keep({ text: "Ny text" }));
  await kept.unmount();
  refuse = () => false;
  const reloaded = await mount(createElement(Review, { start: 4 }));
  assert.deepEqual(draft.yours, { text: "Min text" }, "din version survives the reload");
  await reloaded.unmount();
});

test("the recorder hears a muted microphone after 15 s of zeros, never a quiet room, and stops saying so when sound returns", async (t) => {
  const { createElement } = await import("react");
  const { useSilence } = await import("../components/flow/recording-hooks");
  // What the microphone gives: the loudest sample of each read.
  let peak = 0;
  class FakeAudioContext {
    state = "running";
    resume = async () => undefined;
    close = async () => undefined;
    createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
    createAnalyser = () => ({ fftSize: 0, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0).fill(peak, 0, 1) });
  }
  const page = window as unknown as { AudioContext?: unknown };
  const browserAudio = page.AudioContext;
  page.AudioContext = FakeAudioContext;
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let silent = false;
  const microphone = {} as MediaStream;
  function Recorder() {
    silent = useSilence(microphone, true);
    return null;
  }
  const view = await mount(createElement(Recorder));
  // A read at a time: a mocked tick moves the clock to its end before the timers it runs.
  const listen = (ms: number) =>
    view.act(async () => {
      for (let passed = 0; passed < ms; passed += 66) t.mock.timers.tick(66);
    });
  try {
    await listen(14_800);
    assert.equal(silent, false);
    await listen(400);
    assert.equal(silent, true, "15 s of zeros: a muted or wrong microphone");
    peak = 0.3;
    await listen(100);
    assert.equal(silent, false, "sound returns");
    peak = 10 ** (-70 / 20); // a quiet room's tone
    for (let minute = 0; minute < 10; minute += 1) {
      await listen(60_000);
      assert.equal(silent, false, `a quiet room, minute ${minute + 1}`);
    }
  } finally {
    await view.unmount();
    page.AudioContext = browserAudio;
  }
});
