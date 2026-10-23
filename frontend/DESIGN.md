---
name: Tal till text
description: An Eneo module that turns a recorded or uploaded conversation into text or a document.
colors:
  accent: "light-dark(#1563BC, #52B1FF)"
  on-accent: "light-dark(#FFFFFF, #06101C)"
  background-body: "light-dark(#F4F7FB, #070C16)"
  background-surface: "light-dark(#FFFFFF, #0B1322)"
  background-card: "light-dark(#FFFFFF, #0F1828)"
  text-primary: "light-dark(#141A26, #E4E9F0)"
  text-secondary: "light-dark(#4F5A6B, #9AA8BC)"
  border: "light-dark(rgba(20,40,80,.08), rgba(255,255,255,.07))"
  border-emphasized: "light-dark(#758093, #6E7E96)"
  error: "light-dark(#AA181D, #F47B7F)"
  record: "light-dark(#dc2828, #dd2c2c)"
typography:
  body:
    fontFamily: "Figtree Variable, -apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.5
  display:
    fontFamily: "Figtree Variable"
    fontSize: "clamp(1.75rem, 1.35rem + 1.6vw, 2.5rem)"
    fontWeight: 700
  headline:
    fontFamily: "Figtree Variable"
    fontSize: "1.75rem"
    fontWeight: 700
  supporting:
    fontSize: "0.875rem"
rounded:
  inner: "6px"
  element: "10px"
  container: "16px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.element}"
    height: "48px"
---

# Design System: Tal till text

## Overview

**Creative North Star: "Eneo, luftig"**

A calm public-sector tool in Eneo's look: Astryx components on the module's theme (`kit/theme/eneo.theme.ts`), one
accent (the deployment's, Eneo blue by default), Figtree, and the tokens of the design system for every value. White
cards rest on a blue-white ground under a white bar. One bold move per kind of moment: arriving has the display title
and the icon tiles; recording has the stage and its clock; reading has the speakers' colours and the file as the hero.
Everything else stays quiet: no gradient, glow or wash, and nothing that moves to look alive.

**Key Characteristics:**
- One primary action per state: a 48 px accent button, full width in its column, docked at the bottom in one column (a
  phone, a tablet upright). A review's decision is the design system's middle size (32 px with a mouse, 44 px on touch).
  The speaker review keeps its decision in the page on a phone too, under the speakers: the transcript's player docks at
  the bottom there, and two bars would cover a fifth of the screen. On a phone what Godkänn does to speakers without a
  name is said under the decision, not at the speakers' card's foot, so the decision starts on a 320 px first screen.
- The flow page is a column of 20 to 24 rem for the flow (name, description, how it works, classification) beside the
  working card from 1024 px; one column below it, where the setup's choice of way in comes right after the flow's name
  (on a tablet its description too), how it works follows the work, and the classification follows the choice. The
  setup's details (Deltagare) stand in the working card at every width, by the speaker controls they fill in; while the
  page holds audio or a run they are the flow's, folded on a phone or tablet.
- Status uses icons and text together; colour never carries meaning alone.

## Colors

One accent and neutral surfaces, declared once for both colour modes with `light-dark()`.

### Primary
- **Eneo blue** (`#1563BC` / `#52B1FF`): the primary action, the selection, links, the focus ring and the `accent`
  icon tiles. A deployment replaces it (`ORGANIZATION_ACCENT`), at 4.5:1 or more on every ground.

### Neutral
- **Body, surface and card** (`#F4F7FB`/`#070C16`, `#FFFFFF`/`#0B1322`, `#FFFFFF`/`#0F1828`): the page rests on the
  body colour; the bar is the surface; cards are white. In dark mode a surface lightens as it rises.
- **Text** (`#141A26`/`#E4E9F0`, secondary `#4F5A6B`/`#9AA8BC`).
- **Borders** (a hairline `rgba(20,40,80,.08)`; a control's edge `#758093`/`#6E7E96`, 3:1 on every ground, also the
  position slider's unplayed track).

### Categorical hues
- web-next's purple, teal and green, as a tile's tint and icon (`components/IconTile.tsx`), and its yellow for "Osäkert
  förslag". A hue says what a thing is (purple a document, teal a file, green a success), never a hash of its name.

### Domain colours (`styles/globals.css`)
- The recording dot, never the error red; six speaker colours (web-next's purple, teal, amber, rose and green, then
  olive, with a fifth less chroma in dark mode, so a name reads as a tint and not a glow), none the brand's blue; the
  review mark and the done green.

## Typography

**Body Font:** Figtree (bundled, same-origin) with platform fallbacks; scale base 16 px, ratio 1.2.

- **Display** (700, 28 to 40 px fluid, −0.02 em): an arrival's title ("Välj ett flöde", the flow's name, the sign-in).
  Under 360 px the setup's flow name is a step under it (23 px), so a name of a few words keeps one line.
- **Headline** (700, 28 px, −0.01 em): a state's heading (h1).
- **Title** (700, 23 px; h3 600, 19 px): h2 section headings ("Hur vill du lägga till ljudet?", "Tidigare körningar"). A
  heading's look follows its level in the outline: an h3 that says it is an h2 (`aria-level`) reads as an h3 in some
  assistive technology.
- **Body** (400, 16 px, 1.5).
- **Supporting** (14 px, secondary colour): descriptions under labels and lines under actions. What has a consequence
  (the review's deadline and what to do, what Skapa dokument does to a recording, that a page closed during an upload
  stops it) is body text in the secondary colour, never a footnote. Nothing is set below 14 px, a speaker mark's letter
  included: its disc grows with it at the reader's large text. A field's words and every paragraph wrap with no word alone on their last line
  (`text-wrap: pretty`, `styles/globals.css`).

Words with no break point wrap (`overflowWrap: anywhere` on text and headings) rather than reaching past 320 px.
A heading that wraps balances its lines (`text-wrap: balance`), so its last line does not hold one word alone, and a long
compound in it is hyphenated (`hyphens: auto`, the page is `lang="sv"`): "Samtalssamman-ställning", not a break inside a
syllable.
Every size is in rem, so the text follows the reader's own size: the browser's setting and, on an iPhone or iPad, the text size set in iOS (17 px at the default size, through `-apple-system-body`). A dock (the phone's bottom action bar, the player) that large text makes taller than a third of the window stands at the page's end instead of over it.

## Layout

The page column is `--module-page-width` (1180 px), centred; the shell's bar and the page share the same left edge at every width.
The result with its transcript and the speaker review widen with a large window, up to 1600 px; document prose keeps a 75ch reading measure, and a note across a wide card (a run's, the unsent recordings') about 75 characters, its lines balanced (`[data-measure]`, `styles/globals.css`).
Breakpoints: 768 px (the page gets its own gutter; the phone's dock ends) and 1024 px (two columns). A short screen
(480 px high) puts the flow beside the stage, and beside a run's card (sending, progress, failure), in a column a third
of the width up to 17 rem. Every view of the flow,
the setup's form included, is as wide as its column, so each ends at the same edge; a document alone fills the page's
column with its prose capped at the reading measure, and the text review keeps a reading column (672 px). From 1024 px the transcript's card of the result and the review stands
beside the heading from the page's top, keeps to the window as the page scrolls and is as tall as the window below the
bar (`--view-fit-height`, FlowFrame) less a gutter, so its player is in view before anything is scrolled. The flow's
column is the same in every state: its name is the display title, also where a run's card holds the page's heading
(sending, progress, failure), where it is words at that size rather than a heading. Below 1024 px, while the page
holds audio or a run, the name labels the card at the body's size, a clear step under the card's own heading. A
recording's page starts as far
under the bar as every other view, so the flow's name stays where it is when a recording starts and stops. A row that
holds a control and what it drives measures itself (a container query at 30 rem): the microphone's test and its level
stand beside each other from it, each takes the row below it. Section rhythm uses the spacing tokens: 24 px between a
card's sections (the working card's too, so the setup's action is on a laptop's first screen), 16 px
inside a group, 8 px between a label and its control. A control that pairs a label with a switch is as wide as the working
card's content. The recording's stage fills the
window's height up to 44 rem, and its bar follows it: a window-high card around one clock is empty on a 4K display.
Controls a finger presses stand at least 8 px apart (WCAG 2.5.8 asks 24 px targets; the house asks 44 px and room
between them): chips, a passage's name and time, a file's actions, the player's tools.

## Elevation & Depth

Edge or shadow, never both. In light mode a white card on the tinted ground carries the low shadow (`--shadow-low`) and
no edge; in dark mode, where a drop does not show on the near-black page, it has its hairline (`--color-border`) and no
drop. A muted card is not lifted: it keeps its edge. A phone's dock lifts off the page the same way: a soft upward shadow
in light mode, its top edge in dark mode. Rows inside a card never lift; they tint on hover. Menus, popovers and dialogs
keep the medium and high shadows. A card is never drawn inside another: in the working card the classification is its
tile and words alone, the microphone and a run's steps stand by their spacing and their labels, and the ways in are rows
without a box. What must stand apart in it (the drop zone, the chosen file) has its edge and no drop.

## Shapes

Concentric: cards 16 px, a row inside a card 12 px, controls 10 px, tiles 6 or 10 px; pills, avatars and
switches round. One-pixel borders are `var(--border-width)`.

## Components

### Buttons
- **Primary:** a flat accent fill in both colour modes, with the design system's own hover and press overlays: no
  gradient and no glow. 48 px for the one action a screen exists for, the middle size in a review's decision;
  labels wrap instead of truncating. A dialog has one too: what else stays in reach in it (a recording's Pausa and
  Stoppa while the login is renewed) is secondary.
- **Secondary:** outlined, never a grey slab: the card's colour inside a control's edge, for side actions (Testa
  mikrofonen, Öppna, Spara ljudfil, Dela). Disabled keeps a hairline and the disabled text.
- **Ghost:** the bar's way back, icon actions, and a view's quiet way to start over (the result's Ny inspelning). A
  ghost button that starts or ends a row keeps its padding outside the column: its icon or its words stand on the
  content's edge, where the heading or the field above starts or ends.
- **Decisions** (a review's Avvisa and its approval, a ready recording's Fortsätt spela in and Skapa dokument, a
  dialog's Avbryt and Spara): one row at the end of their space, the main action last; up to 640 px wide a stack across
  the whole width, the main action on top and first for the keyboard (`components/ActionRow.tsx`, as Astryx's alert
  dialog lays out its own). A dialog that takes a phone's whole screen (the naming) keeps Spara alone: the × in its
  title is the way out. A failed run's way on comes right after what went wrong, the line that says what it does under
  it. An editor's own buttons are no decision: small, Avbryt before Spara, in the text's header above the field (the
  review's Redigera, Avbryt redigering and Spara ändring) or under a passage being corrected. In the header they stand
  at the end of the text's name where the row has room, and under it, from its start, where it has not: never one button
  alone at the far end of a row. A long text under review keeps that header at the window's top and the decision at its
  bottom, with one page scroll.
- **A card's own action** stands at the end of the card's heading row, never on a row of its own between rules:
  "Transkribering … Ladda ner", "Talare … Namnge talarna". The review's decision is the page's, under the speakers' card
  and not in its group.
- **An action stands with what it acts on:** the microphone test under Spela in, the chosen file under Ladda upp.

### Inputs / Fields
- Astryx fields with label above and description under the label; focus ring 2 px accent around the whole field.

### Navigation
- The header has one persistent “Alla flöden” link in the navigation group. It names its destination; leaving unsent work uses the existing leave question.
- The header is one line at every width and never holds the flow's name: a view without the flow's column names the flow right under its heading, in the secondary colour (the result's meta line with its date, the review's own line). A review says by when right under the flow's name, in view before anything is scrolled; what to do follows, set apart.
- An organisation's logo stands in the bar wherever the bar has room for it beside the product's name, which is every width at an ordinary text size; with the reader's largest text or a phone's 200 % zoom it is left out with its divider (measured, `components/Brand.tsx`). Its name without a logo stands on one line below 640 px, under the same measure: otherwise it is left out with its divider and the bar reads “Tal till text” alone. From 640 px the name takes two lines at most. The brand link names the organisation whole either way, and so does the sign-in's line under its card.
- On a flow's page the brand stands in the bar from 768 px; on a phone the bar keeps its room for the way back and the account. While an upload is under way the page offers no way off it, and the brand alone fills the bar at every width, so the bar keeps its height and the organisation its place.
- A pill that only says something ("Väntar på din granskning", "Senast använd", "Osäkert förslag") is as tall as its words, with a little room above and below them in its fill, at every pointer, so it never reads as a button beside one; only a removable chip is a control's height. A pill stands beside what it qualifies, never above a heading as a label: the review's state follows its heading on the same row from 640 px; on a phone the deadline under the heading says it, and the row has no pill. A card's heading says what is left to do on its own (the unsent recordings).

### Version
- Folded under “Version” at the end of the flow list: the release (no row without one), the commit and the build time as a key-value list, then Kopiera supportinformation and the commit on GitHub. Not in the account menu, whose rows fill Astryx's 300 px menu on a touch screen.

### Steps
- A run's steps say their state in words and an icon, without a bar: the step under way has the spinner, a finished one its check, a failed one its cross. The icons stand on the content's edge, under the heading's first letter.
- A failed run's note is red only when nothing the person can do mends it: a failure Försök igen may mend, and a
  recording or file the flow cannot take, are a warning; a stopped run is information.

### Setup
- Each way in says what happens to the audio: Strömma sends it to Eneo as it is spoken, Spela in keeps it on the device
  until it is sent.
- The microphone test stands right under the way in that records with it. The picker's description says when to test and
  that the test sound is neither recorded nor sent; while the browser asks for the microphone the test can already be
  stopped, and after a moment it says where the question is. A microphone that goes quiet (muted) or away during the test
  no longer counts as heard.
- What appears when a control is pressed has its place from the first draw: the microphone's picker spans the section, its
  description the same words whatever the browser knows of its microphones; under it the test beside its level, which
  rests unlit until the test starts; under them, on a line of its own, what the test says ("Testet visar här om
  mikrofonen hör dig."). Nothing moves when a test starts or the browser names its microphones. The button keeps one
  width for both of its words, and its icon says which it is (the microphone, a stop); on a phone it takes the row, as
  the phone's other actions do.
- In one column the classification stands once more where the person commits: one line, "Flödet får ta emot: {namn}",
  docked with the primary action, where the window is taller than 640 px (a small phone's dock keeps to the action, and
  the note at the working card's end says it). From a laptop's width its own note is in view beside the action instead,
  in the flow's column. A flow whose result goes on to a receiver says so above the setup's action, and above the
  recording's Skapa dokument.
- The recordings to go on with or send stand above the working card, a card of their own, never in it, with the working
  card's padding, so the two share their content's edge. On a phone their card has no tile: its heading, its words and
  its actions share one edge.
- The flow's details follow the choice of way in, in the working card at every width: a field being typed in when the
  layout changes (a tablet turned) does not move. A name typed in the participants' field is kept when the field goes
  (a recording started). Its Lägg till is one piece with the field and off until a name is typed; off, it keeps the
  field's edge, so the two still read as one control. Empty, the field offers the names it was last sent with on this
  flow in one press ("Lägg till förra gångens namn (2)", a ghost button where the chips will be), and Märk upp talare
  starts as the person last left it on the flow.
- A run of the flow that waits for the person's review is said above the setup's work, an information banner with its
  Granska, the newest one: Eneo cancels a review not done in time. The earlier runs list them all.

### How it works
- "Så fungerar det": the steps a run takes the person through, said only as the run contract states them
  (`lib/flow-output.ts`, `howItWorks`), and tips for good sound folded under them. From 1024 px it is open under its own
  heading, under the flow's description; below, one folded row like the details' fold after the work, so the choice of
  way in comes first. On a phone the flow's description opens it, read once there rather than over the choice: the
  person read it in the flow's row of the list.

### Recording notices
- What can lose part of the meeting is a warning above Pausa and Stoppa (no sound, no microphone, no room on the device, less than five minutes to the flow's longest recording), and what the person could do to lose sound ("Lås inte skärmen och byt inte app") a calm line above them at the body's size, part of the controls, so a short screen that pins them pins it too; what else matters now is a line under them. The lines follow the controls: centred under Spela in's stage, from the bar's start in Strömma. Below 768 px Strömma leaves out the line under Stoppa, so the live text has the room; Spela in, whose stage has room, keeps it. There the live sheet's head is its log's first line: the Preliminär pill, and when the final text comes on a line of its own under it.
- Pinned on a short screen, the controls' card stands a gutter above the window's edge. Where the reader's large text
  makes what is pinned (the bar, or the stage and the controls) leave less than 6 rem for a warning, nothing is pinned:
  it all stands in the page's flow, as a dock that tall does, and Pausa and Stoppa stand one above the other where they
  have less than 5.5 rem each. Under 400 px Strömma's status, clock and level share one row over the buttons. In a window as low as a laptop's at 400 % zoom, Strömma's controls stay in the page's flow, so they never cover the live text that has the focus.
- From 768 px Pausa and Stoppa are the stage card's footer, at the middle of it (25 rem), with one hairline between the
  stage and them.

### Strömma for a room
- "Visa i helskärm" at the live sheet's head puts the recording's section (the sheet and the bar with Pausa and Stoppa)
  alone on the whole screen, for a projector or a screen on the wall: a name that says what happens, where "for the
  room" could be read as sharing. Strömma's line in the setup says it too ("också i helskärm för rummet"), so it is known
  before the meeting. Both only where it is offered: from 768 px, in a browser that shows an element on the whole
  screen (not an iPhone).
- The text is sized from the screen's width (about 74 px on a 1920 px picture, 54 px on 1280: some 45 characters a
  line), in medium weight with caption leading.
- What the room reads speaks to no one in particular: "Preliminär text, kan innehålla fel", and live text's notices
  without the presenter's "när du stoppar". A pause is written where the text stopped, for a room that sees the bar
  only from afar; a screen reader hears it once, from the page, whose announcements stand inside the section. The bar
  keeps its controls and warnings, and leaves out its calm lines to the presenter.
- Esc or "Lämna helskärm" brings the page back, and the room view ends with the recording.

### Files
- A file is a row: its type, name and size, and its download at the row's end. Under 360 px the document's own file keeps its download and Dela on one row, Dela as its icon. The document's own file has the one filled download; from a laptop's width it stands on that row, after opening the file (an outlined icon) and Dela, all as tall as each other, and above the document's text when the text comes first. A row too short for the name and its actions puts the actions under the name, at the row's end as beside it, never a name of three lines between them.

### Transcript
- The transcript's Kopiera and Ladda ner som text stand at the end of its heading's row where they fit on one line and
  fold into one "Fler alternativ" menu where they do not, as the document's own actions do. Below 1024 px the tab names
  the transcript, and its heading is there only for a screen reader: the two then join the first row of the transcript's
  tools, after "Namnge talare" where the speakers can be named, so no row holds them alone. Passages stand 32 px apart.
- Where the speakers can be named (a finished run whose transcript can be corrected) they have a row of their own above
  the filter: "Talare" at its start, which is also the filter's name (the chips' group, or the list that stands in for
  them), and "Namnge talare" at its end, a ghost button with its icon as the heading's Kopiera and Ladda ner som text
  are. Under 640 px the filter's list takes the word's place, and "Namnge talare" and the transcript's menu stand at its
  end as icons: one row for three. Where they cannot be named (a run waiting for its review, a failed run, a transcript
  that cannot be corrected) the chips stand alone, named "Visa talare". The speaker review's own view has no filter for
  the word to name: there "Namnge talare" stands at the start of the transcript's Kopiera and Ladda ner below a laptop's
  width, and alone at the end of a row above it from one; its tools for speaker suggestions show only while there is one
  to decide or step through. A passage's "Ändra talare" offers
  "Byt namn på" its speaker after the choice and what it applies to, after the run and in the review's pause alike: it
  opens the naming dialog at that speaker, and the focus goes back to the passage when it closes.
- A passage's pieces are one element each (no wrapper per word), and a passage is laid out only when it is near the
  window (`content-visibility: auto`, on each passage: a box that skips several passages at once leaves them out of
  Chromium's accessibility tree): an hour's meeting is tens of thousands of words. The speaker filter hides the passages it leaves
  out and keeps them in the page. On a phone a passage's coloured
  rule and its name say whose it is; its mark stands beside it from 640 px.
- A transcript that was read and is empty says so in its place ("Inget tal hittades i ljudet."): never an empty tab or
  column.
- The player docks to the text. On a phone it is under the text and stays at the window's bottom, where a thumb reaches
  it, one row high: its speed stands in the row, and under 400 px the time says the position alone, the speed its words
  without a chevron, and the controls stand 8 px apart, so the slider keeps its 120 px. From 640 to 1023 px, where the
  page scrolls and a bottom player would cover the passages the window starts on, it stands above the text under the
  tools and stays at the window's top. From 1024 px it sits at the bottom of the transcript's card, and on a screen
  under 480 px high at the text's end.
- With a mouse, one quiet line above the player's row says its keys: "Tangenter: K spelar och pausar, J och L hoppar 10
  sekunder." Where the line is, K, J and L work from anywhere on the page. A touch screen has no line, so there they act
  only with the focus in the player (a keyboard of the tablet's own). The line ends with "Stäng av", set in the line's
  own size, and off it says "Tangenterna K, J och L är avstängda." and offers "Slå på". The choice is kept for the
  person in the browser. Space and the arrows are the player's only with the focus on it, and are never turned off. The
  speed chosen is kept for the person too: the next transcript plays at it. Esc in the search empties it, as a browser's
  own find does; while a query shows its count and arrows, the search takes the row under the chips.

### Transcript feedback
- A selected or played word stays highlighted at the paused playhead. The active search hit uses an underline and outline, distinct from the filled playback highlight; every other match its tint and a dotted underline, so no match is marked by colour alone.

### Choice
- Radio lists for one choice of a few, each a row without a box of its own, its radio on the content's edge and its
  padding outside the column; the chosen row is tinted and its radio filled. A switch with its label for an option that
  is on or off. A line that says a
  state in its words offers the one action that changes it instead, as the player's line of keys does (Stäng av, Slå
  på) beside its Följ uppspelningen.
- Filter chips (toggle buttons, the transcript's speakers) are the middle size, as tall as the search field beside them
  (under them where the row has no room for both), and stand 8 px apart with any pointer. They have a control's edge at
  rest and the accent's edge and tint when pressed. Where they would take more than one row (more than five speakers
  below 1024 px, more than two on a phone, any two under 360 px) the filter is a list.

### Bespoke surfaces
- Transcript text with per-word spans, the level meter, the docked player, the live text sheet: CSS Modules with
  Astryx tokens.

## Motion

Calm and quick, on the design system's tokens: `--duration-fast` (175 ms) with `--ease-standard`. A view of the flow
that takes another's place fades in (opacity only: the recording's bar is sticky), and so does what a disclosure
opens; a dialog opens over `--duration-fast-max`. The step under way shows the spinner, and a paused timer turns to
the secondary colour. A status stands still: the recording's red dot does not pulse, its clock and level show that it
records. A page's loading spinner shows only after `--module-wait-delay` (300 ms), so an answer within it
leaves no blink. A search hit is brought into view at once, as a browser's own find does. Hover styles apply only where
a pointer hovers (`@media (hover: hover)`): on a touch screen a tapped control would keep them. With reduced motion
nothing fades, nothing turns (a chevron shows open or closed by where it ends) and spinners stand still. A scroll the page makes by itself over more than a window and a half jumps rather than glides.

## Do's and Don'ts

- Do take every colour, size and space from a token; fix a shortfall once in the theme.
- Do keep a control next to its label and the primary action in reach at every width.
- Do give an action that is on its way its place from the first draw, disabled until it can be pressed: what arrives
  late must not move what is already on screen.
- Don't add a second accent or decorative colour; don't wrap list rows in cards.
- Don't use Tailwind utilities, StyleX, or raw hex or pixel values in components.
