---
name: Tal till text
description: An Eneo module that turns a recorded or uploaded conversation into text or a document.
colors:
  accent: "light-dark(#004595, #52B1FF)"
  on-accent: "light-dark(#FFFFFF, #0B1118)"
  background-body: "light-dark(#F0F0F6, #0E1115)"
  background-surface: "light-dark(#FBFCFF, #191C1F)"
  text-primary: "light-dark(#1B1B1F, #DFE3E8)"
  text-secondary: "light-dark(#454650, #A5ACB6)"
  border: "light-dark(#1B1B1F1A, #EDF1F61A)"
  border-emphasized: "light-dark(#85868F, #626972)"
  error: "light-dark(#AA181D, #F47B7F)"
  record: "light-dark(#dc2828, #dd2c2c)"
typography:
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.5
  headline:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
  supporting:
    fontSize: "0.875rem"
rounded:
  element: "8px"
  container: "12px"
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

**Creative North Star: "The quiet municipal desk"**

A calm, plain work surface for public-sector staff: Astryx components on the module's theme
(`kit/theme/eneo.theme.ts`), one accent (the deployment's, Eneo blue by default), system fonts, and the tokens of the
design system for every value. The page is one surface colour from the bar to the window's end. Density is moderate;
hierarchy comes from type size, weight and spacing, not from colour or containers.

**Key Characteristics:**
- One primary action per state: a 48 px accent button, full width in its column, docked at the bottom on a phone.
- The flow page is a 20rem column for the flow (name, description, how it works, classification, details) beside the
  working card from 1024 px; one column below it, where the setup's choice of way in comes right after the flow's
  description and how it works, and the details and the classification follow the choice.
- Status uses icons and text together; colour never carries meaning alone.

## Colors

One accent and neutral surfaces, declared once for both colour modes with `light-dark()`.

### Primary
- **Eneo blue** (`#004595` / `#52B1FF`): the primary action, the selection, links and the focus ring. A deployment
  replaces it (`ORGANIZATION_ACCENT`), at 4.5:1 or more.

### Neutral
- **Body and surface** (`#F0F0F6`/`#0E1115`, `#FBFCFF`/`#191C1F`): the page rests on the surface colour.
- **Text** (`#1B1B1F`/`#DFE3E8`, secondary `#454650`/`#A5ACB6`).
- **Borders** (`#1B1B1F1A`; a control's edge `#85868F`/`#626972`, 3:1).

### Domain colours (`styles/globals.css`)
- The recording dot, never the error red; six speaker tints, none the brand's blue; the review mark and the done green.

## Typography

**Body Font:** system-ui with platform fallbacks; scale base 16 px, ratio 1.2.

- **Headline** (600, 28 px): the flow's name and a state's heading (h1).
- **Title** (600, 23 px / 19 px): h2 section headings ("Hur vill du lägga till ljudet?", "Tidigare körningar"). A
  heading's look follows its level in the outline: an h3 that says it is an h2 (`aria-level`) reads as an h3 in some
  assistive technology.
- **Body** (400, 16 px, 1.5).
- **Supporting** (14 px, secondary colour): descriptions under labels and lines under actions. What has a consequence
  (the review's deadline and what to do) is body text in the secondary colour, never a footnote. Nothing read is set
  below 14 px; 11 px is the speaker marks' numerals only.

Words with no break point wrap (`overflowWrap: anywhere` on text and headings) rather than reaching past 320 px.
A heading that wraps balances its lines (`text-wrap: balance`), so its last line does not hold one word alone, and a long
compound in it is hyphenated (`hyphens: auto`, the page is `lang="sv"`): "Samtalssamman-ställning", not a break inside a
syllable.
Every size is in rem, so the text follows the reader's own size: the browser's setting and, on an iPhone or iPad, the text size set in iOS (17 px at the default size, through `-apple-system-body`). A dock (the phone's bottom action bar, the player) that large text makes taller than a third of the window stands at the page's end instead of over it.

## Layout

The page column is `--module-page-width` (1180 px), centred; the shell's bar and the page share the same left edge at every width.
The result with its transcript and the speaker review widen with a large window, up to 1600 px; document prose keeps a 75ch reading measure.
Breakpoints: 768 px (the page gets its own gutter; the phone's dock ends) and 1024 px (two columns). A short screen
(480 px high) puts the flow beside the stage, in a column a third of the width up to 17 rem. Every view of the flow,
the setup's form included, is as wide as its column, so each ends at the same edge; a document alone fills the page's
column with its prose capped at the reading measure, and the text review keeps a reading column (672 px). From 1024 px the transcript's card of the result and the review stands
beside the heading from the page's top, keeps to the window as the page scrolls and is as tall as the window below the
bar (`--view-fit-height`, FlowFrame) less a gutter, so its player is in view before anything is scrolled. The flow's
column is the same in every state: from 1024 px its name is the headline's size also where a run's card holds the
page's heading. A row that holds a field and a button
measures itself (a container query at 36 rem): the field fills the row below it, the two stand beside each other from
it. Section rhythm uses the spacing tokens: 24 px between a card's sections, 16 px
inside a group, 8 px between a label and its control. A control that pairs a label with a switch is no wider than the
microphone row (36 rem): across a laptop's column the two would stand 800 px apart. The recording's stage fills the
window's height up to 44 rem, and its bar follows it: a window-high card around one clock is empty on a 4K display.
Controls a finger presses stand at least 8 px apart (WCAG 2.5.8 asks 24 px targets; the house asks 44 px and room
between them): chips, a passage's name and time, a file's actions, the player's tools.

## Elevation & Depth

Flat. Depth is tonal: bordered containers (12 px radius) on the surface colour. Shadows appear only on overlays
(menus, popovers, dialogs) from the design system.

## Shapes

Elements 8 px, containers 12 px, avatars and switches round. One-pixel borders are `var(--border-width)`.

## Components

### Buttons
- **Primary:** accent fill, 48 px for the one action a screen exists for; labels wrap instead of truncating. A dialog
  has one too: what else stays in reach in it (a recording's Pausa and Stoppa while the login is renewed) is secondary.
- **Secondary:** muted fill for side actions (Testa mikrofonen, Öppna).
- **Ghost:** the bar's way back, icon actions, and a view's quiet way to start over (the result's Ny inspelning).
- **Decisions** (a review's Avvisa and its approval, a ready recording's Fortsätt spela in and Skapa dokument, a
  dialog's Avbryt and Spara): one row at the end of their space, the main action last; up to 640 px wide a stack across
  the whole width, the main action on top and first for the keyboard (`components/ActionRow.tsx`, as Astryx's alert
  dialog lays out its own). An editor's own buttons are no decision: small, Avbryt before Spara, in the text's header
  above the field (the review's Redigera, Avbryt and Spara ändring) or under a passage being corrected. A long text
  under review keeps that header at the window's top and the decision at its bottom, with one page scroll.
- **A card's own action** stands at the end of the card's heading row, never on a row of its own between rules:
  "Transkribering … Ladda ner", "Talare … Namnge talarna". The review's decision is the page's, under the speakers' card
  and not in its group.
- **An action stands with what it acts on:** the microphone test under Spela in, the chosen file under Ladda upp.

### Inputs / Fields
- Astryx fields with label above and description under the label; focus ring 2 px accent around the whole field.

### Navigation
- The header has one persistent “Alla flöden” link in the navigation group. It names its destination; leaving unsent work uses the existing leave question.
- The header is one line at every width and never holds the flow's name: a view without the flow's column names the flow in its own first line (the review's "Väntar på din granskning", the result's date line).

### Version
- Folded under “Version” at the end of the flow list: the release (no row without one), the commit and the build time as a key-value list, then Kopiera supportinformation and the commit on GitHub. Not in the account menu, whose rows fill Astryx's 300 px menu on a touch screen.

### Steps
- A run's steps say their state in words; the step under way has the accent bar and the spinner, a finished one its check and the plain track.
- A failed run's note is red only when nothing the person can do mends it: a failure Försök igen may mend, and a
  recording or file the flow cannot take, are a warning; a stopped run is information.

### Setup
- Each way in says what happens to the audio: Strömma sends it to Eneo as it is spoken, Spela in keeps it on the device
  until it is sent.
- The microphone test stands right under the way in that records with it. The picker's description says when to test and
  that the test sound is neither recorded nor sent; while the browser asks for the microphone the test can already be
  stopped, and after a moment it says where the question is. A microphone that goes quiet (muted) or away during the test
  no longer counts as heard.
- What appears when a control is pressed has its place from the first draw: the microphone test's level line rests until the test starts, and its button keeps one width for both of its words, so nothing under them moves.
- The classification stands once more where the person commits: one line, "Flödet får ta emot: {namn}", above the
  setup's primary action, and docked with it on a phone. The card with the organisation's description stays with the flow.
  A flow whose result goes on to a receiver says so there too, and above the recording's Skapa dokument.
- In one column the flow's details follow the choice of way in; a field being typed in when the layout changes (a tablet
  turned) keeps the focus, and a name typed in the participants' field is kept.

### How it works
- "Så fungerar det" under the flow's description: the steps a run takes the person through, said only as the run contract
  states them (`lib/flow-output.ts`, `howItWorks`), and tips for good sound folded under them. From 1024 px it is open
  under its own heading; below, one folded row like the details' fold, so the ways in stay on the first screen.

### Recording notices
- What can lose part of the meeting is a warning above Pausa and Stoppa (no sound, no microphone, no room on the device, less than five minutes to the flow's longest recording); what else matters now is a calm line under them.

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
- A file is a row: its type, name and size, and its download at the row's end. The document's own file has the one filled download; from a laptop's width it stands on that row, and above the document's text when the text comes first. A row too short for the name and its actions puts the actions under the name, never a name of three lines between them.

### Transcript
- The transcript's Kopiera and Ladda ner som text stand beside its heading where the row has room and fold into one
  "Fler alternativ" menu where it has not, as the document's own actions do. Passages stand 32 px apart.
- Where the speakers can be named (a finished run whose transcript can be corrected) they have a row of their own above
  the filter, at every width: "Talare" at its start, which is also the filter's name (the chips' group, or below 1024 px
  the list that stands in for more than five chips), and "Namnge talare" at its end, a ghost button with its icon as the
  heading's Kopiera and Ladda ner som text are. Where they cannot be named (a run waiting for its review, a failed run, a
  transcript that cannot be corrected) the chips stand alone, named "Visa talare". The speaker review's own view has no
  filter for the word to name: there "Namnge talare" stands alone at the end of a row above it. A passage's "Ändra
  talare" offers "Byt namn på" its speaker after the choice and what it applies to; both open the review's naming
  dialog, and the focus goes back where it was opened.
- A passage's pieces are one element each (no wrapper per word), and a passage is laid out only when it is near the
  window (`content-visibility: auto`): an hour's meeting is tens of thousands of words.
- A transcript that was read and is empty says so in its place ("Inget tal hittades i ljudet."): never an empty tab or
  column.
- The player docks to the text. On a phone it is under the text and stays at the window's bottom, where a thumb reaches
  it. From 640 to 1023 px, where the page scrolls and a bottom player would cover the passages the window starts on, it
  stands above the text under the tools and stays at the window's top. From 1024 px it sits at the bottom of the
  transcript's card, and on a screen under 600 px high at the text's end.

### Transcript feedback
- A selected or played word stays highlighted at the paused playhead. The active search hit uses an underline and outline, distinct from the filled playback highlight.

### Choice
- Radio lists for one choice of a few; a switch with its label for an option that is on or off.
- Filter chips (toggle buttons, the transcript's speakers) have a control's edge at rest and the accent's edge and tint when pressed, as a chosen radio row has.

### Bespoke surfaces
- Transcript text with per-word spans, the level meter, the docked player, the live text sheet: CSS Modules with
  Astryx tokens.

## Motion

Calm and quick, on the design system's tokens: `--duration-fast` (175 ms) with `--ease-standard`. A view of the flow
that takes another's place fades in (opacity only: the recording's bar is sticky), and so does what a disclosure
opens; a dialog opens over `--duration-fast-max`. The step under way shows the spinner, and a paused timer turns to
the secondary colour. A page's loading spinner shows only after `--module-wait-delay` (300 ms), so an answer within it
leaves no blink. A search hit is brought into view at once, as a browser's own find does. Hover styles apply only where
a pointer hovers (`@media (hover: hover)`): on a touch screen a tapped control would keep them. With reduced motion
nothing fades and spinners stand still.

## Do's and Don'ts

- Do take every colour, size and space from a token; fix a shortfall once in the theme.
- Do keep a control next to its label and the primary action in reach at every width.
- Do give an action that is on its way its place from the first draw, disabled until it can be pressed: what arrives
  late must not move what is already on screen.
- Don't add a second accent or decorative colour; don't wrap list rows in cards.
- Don't use Tailwind utilities, StyleX, or raw hex or pixel values in components.
