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
- The flow page is a 20rem column for the flow (name, description, classification, details) beside the working card
  from 1024 px; one column below it.
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
- **Title** (600, 23 px / 19 px): h2 section headings ("Hur vill du lägga till ljudet?", "Tidigare körningar").
- **Body** (400, 16 px, 1.5).
- **Supporting** (14 px, secondary colour): descriptions under labels and lines under actions.

Words with no break point wrap (`overflowWrap: anywhere` on text and headings) rather than reaching past 320 px.
A heading that wraps balances its lines (`text-wrap: balance`), so its last line does not hold one word alone.

## Layout

The page column is `--module-page-width` (1180 px), centred; the shell's bar and the page share the same left edge at every width.
Breakpoints: 768 px (the page gets its own gutter; the phone's dock ends) and 1024 px (two columns). A short screen
(480 px high) puts the flow beside the stage, in a column a third of the width up to 17 rem. In one column, a form is
as wide as the column; beside the flow's details it keeps the form measure (`--module-form-width`, 40 rem). A row
that holds a field and a button measures itself (a container query at 36 rem): the field fills the row below it, the
two stand beside each other from it. Section rhythm uses the spacing tokens: 24 px between a card's sections, 16 px
inside a group, 8 px between a label and its control.

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
- **Ghost:** the bar's way back and icon actions.
- **Decisions** (a review's Avvisa and its approval, a dialog's Avbryt and Spara): one row at the end of their space,
  the main action last; up to 640 px wide a stack across the whole width, the main action on top and first for the
  keyboard (`components/ActionRow.tsx`, as Astryx's alert dialog lays out its own). An editor's own buttons are no
  decision: small, at the start of the field, right under it (the review's Avbryt and Spara ändring, Redigera).

### Inputs / Fields
- Astryx fields with label above and description under the label; focus ring 2 px accent around the whole field.

### Navigation
- The header has one persistent “Alla flöden” link in the navigation group. It names its destination; leaving unsent work uses the existing leave question.

### Version
- Folded under “Version” at the end of the flow list: the release (no row without one), the commit and the build time as a key-value list, then Kopiera supportinformation and the commit on GitHub. Not in the account menu, whose rows fill Astryx's 300 px menu on a touch screen.

### Recording notices
- What can lose part of the meeting is a warning above Pausa and Stoppa (no sound, no microphone, no room on the device, less than five minutes to the flow's longest recording); what else matters now is a calm line under them.

### Files
- A file is a row: its type, name and size, and its download at the row's end. The document's own file has the one filled download; from a laptop's width it stands on that row, and above the document's text when the text comes first.

### Transcript feedback
- A selected or played word stays highlighted at the paused playhead. The active search hit uses an underline and outline, distinct from the filled playback highlight.

### Choice
- Radio lists for one choice of a few; a switch with its label for an option that is on or off.

### Bespoke surfaces
- Transcript text with per-word spans, the level meter, the docked player, the live text sheet: CSS Modules with
  Astryx tokens.

## Do's and Don'ts

- Do take every colour, size and space from a token; fix a shortfall once in the theme.
- Do keep a control next to its label and the primary action in reach at every width.
- Do give an action that is on its way its place from the first draw, disabled until it can be pressed: what arrives
  late must not move what is already on screen.
- Don't add a second accent or decorative colour; don't wrap list rows in cards.
- Don't use Tailwind utilities, StyleX, or raw hex or pixel values in components.
