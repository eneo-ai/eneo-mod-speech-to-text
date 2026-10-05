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

## Layout

The page column is `--module-page-width` (1180 px), centred; the shell's bar and the page share the same left edge at every width.
Breakpoints: 768 px (the page gets its own gutter; the phone's dock ends) and 1024 px (two columns). A short screen
(480 px high) puts the flow beside the stage. Section rhythm uses the spacing tokens: 24 px between a card's sections,
16 px inside a group, 8 px between a label and its control.

## Elevation & Depth

Flat. Depth is tonal: bordered containers (12 px radius) on the surface colour. Shadows appear only on overlays
(menus, popovers, dialogs) from the design system.

## Shapes

Elements 8 px, containers 12 px, avatars and switches round. One-pixel borders are `var(--border-width)`.

## Components

### Buttons
- **Primary:** accent fill, 48 px for the one action a screen exists for; labels wrap instead of truncating.
- **Secondary:** muted fill for side actions (Testa mikrofonen, Öppna).
- **Ghost:** the bar's way back and icon actions.

### Inputs / Fields
- Astryx fields with label above and description under the label; focus ring 2 px accent around the whole field.

### Navigation
- The header has one persistent “Alla flöden” link in the navigation group. It names its destination; leaving unsent work uses the existing leave question.

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
- Don't add a second accent or decorative colour; don't wrap list rows in cards.
- Don't use Tailwind utilities, StyleX, or raw hex or pixel values in components.
