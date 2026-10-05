---
name: Tal till text, documentation site
description: The VitePress default theme re-coloured from the module: one restrained blue, cool near-white surfaces, system fonts, hairlines.
colors:
  accent: "#004595"
  accent-deep: "#003672"
  accent-dark-mode: "#52B1FF"
  accent-dark-mode-hover: "#7CC3FF"
  on-accent-dark-mode: "#0B1118"
  page: "#fbfcff"
  page-alt: "#f0f0f6"
  page-soft: "#f4f5fa"
  page-elevated: "#ffffff"
  text-1: "#16181d"
  text-2: "#454852"
  text-3: "#62656f"
  divider: "#e1e2ea"
  border: "#c9cad4"
  dark-page: "#0e1115"
  dark-page-alt: "#14171c"
  dark-page-elevated: "#191c1f"
  dark-text-1: "#eceef2"
  dark-text-2: "#b4b8c2"
  dark-text-3: "#8c919c"
  dark-divider: "#23272c"
  dark-border: "#2e3135"
typography:
  hero-name:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Arial, sans-serif"
    fontSize: "3.5rem"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.025em"
  tagline:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.6
  section-heading:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Arial, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  step-numeral:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1
  code:
    fontFamily: "ui-monospace, \"SFMono-Regular\", Consolas, monospace"
    fontSize: "0.8125rem"
spacing:
  step-gap: "32px"
  section-pad: "32px"
  hero-image-max: "460px"
components:
  button-brand:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
  button-brand-dark-mode:
    backgroundColor: "{colors.accent-dark-mode}"
    textColor: "{colors.on-accent-dark-mode}"
---

# Design System: Tal till text, documentation site

## Overview

**Creative North Star: "Bars into lines"**

This is not a design system of its own. It is the VitePress 1.6.4 default theme, re-coloured from the module's Astryx theme (`frontend/kit/theme/eneo.theme.ts`) in `.vitepress/theme/custom.css`. The site does not import the Astryx stylesheet and loads no font, script or style from another origin. The one drawn idea is a voice envelope of rounded bars turning into lines of text; the mark is six rounded bars and three lines. The page is recognisable with the words removed: bars, hairlines, one blue.

**Key Characteristics:**
- One accent blue, no gradient, no second hue.
- Cool near-white surfaces in light, near-black blue-greys in dark.
- System fonts, bold tight headings, default VitePress body measure.
- Structure by hairline rules, not by cards or shadows.

## Colors

One blue on cool neutrals. Values come from the module token and feed VitePress variables (the frontmatter is normative).

### Primary
- **Module Blue** (accent, `--vp-c-brand-1`): links, hero name, step rules and numerals, focus ring, filled button. In dark mode it becomes **Sky Blue** (accent-dark-mode). Hover/active steps: accent-deep (`--vp-c-brand-2`) in light, accent-dark-mode-hover in dark. `--vp-c-brand-soft` is the accent at 10% (light) and 14% (dark).

### Neutral
- **Cool Paper** (page, `--vp-c-bg`) with **Cool Mist** (page-alt, `--vp-c-bg-alt`), page-soft and page-elevated for sidebar, code and raised panels. Dark: dark-page, dark-page-alt, dark-page-elevated (also the soft surface).
- **Ink tones** text-1, text-2, text-3 for primary, secondary and tertiary text; dark-text-1/2/3 in dark. Taglines and list text use text-2.
- **Hairlines** divider and border (dark-divider, dark-border).

### Module token to VitePress variable
- `color.accent` [#004595, #52B1FF] feeds `--vp-c-brand-1/-3`, `--vp-button-brand-bg`, `--vp-home-hero-name-color`, the favicon, the logo and the hero drawing's bars (via ACCENT in `config.mts`).
- `color.on-accent` [#FFFFFF, #0B1118] feeds `--vp-button-brand-text` (and hover/active text).
- System font stacks feed `--vp-font-family-base` and `--vp-font-family-mono`.
- Focus ring (2px, offset 2px, accent) feeds the global `:focus-visible` rule.
- Scalar (API reference) takes its colours from these same VitePress variables.

### Named Rules
**The Dark Label Rule.** On the dark-mode accent (#52B1FF) the button label is #0B1118, not white, because white on #52B1FF is 2.4:1. Any label placed on the dark-mode accent uses the dark on-accent colour.

**The One Blue Rule.** Accent is the only chromatic colour in the chrome. Hero-drawing text lines are a quiet tone of the same blue (#b9c4d8 light, #3a4659 dark).

## Typography

**Display and Body Font:** system-ui stack (-apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif). **Mono:** ui-monospace stack. No font is loaded.

**Character:** Plain and native; the weight and tracking carry the voice, not a typeface.

### Hierarchy
- **Hero name and headline** (700, 2.5rem below 640px, 3.5rem from 640px, line-height 1.12, -0.025em, balanced wrapping): name in accent over the headline.
- **Tagline** (400, 1.125rem, 1.6, text-2, max 34em, pretty wrapping).
- **Start-page section heading** (1.375rem, 1.3, -0.01em, balanced).
- **Step numeral** (700, 1.5rem, accent); step title 1.0625rem in text-1.
- **API page title** (2rem, 1.2, -0.02em).
- **Body**: VitePress default size and measure; do not widen or narrow it.
- **Diagram source** (mono, 0.8125rem, text-2).

### Named Rules
**The Tight Heading Rule.** Headings on the start and API pages are 700 with negative tracking and balanced wrapping; reading text stays left-aligned at every width.

## Layout

VitePress default layout. Start page: hero (text left, drawing right at up to 460px; below 960px one left-aligned column, actions before the drawing, drawing up to 280px), then a three-step strip (three equal columns from 960px, one column below, 32px gap), then heading-and-text rows. From 960px rows are a 5fr/11fr grid with heading left, text right (48px inset), each row under a hairline; below 960px one column. API page: title and intro capped at 1152px with 24px side padding, Scalar below a top hairline, Scalar header height tied to `--vp-nav-height`. Mermaid diagrams are centred, and below 640px keep a 600px minimum width and scroll sideways.

## Elevation & Depth

Flat. No shadows are authored; depth is tonal (page, page-alt, page-elevated) and structural (1px hairlines, 2px accent step rules).

## Shapes

Rounded bars: the mark and the hero drawing are fully rounded rectangles (radius half the thickness). Everything else keeps VitePress's default corners. Rules are straight hairlines.

## Components

### Buttons
VitePress hero buttons. **Brand:** accent fill, white label (light); Sky Blue fill, #0B1118 label (dark). Hover: #003a80 light, #7CC3FF dark; active: #003672 light, #3fa3f5 dark. **Alt:** VitePress default quiet button. Focus: 2px accent outline, 2px offset.

### Three-step strip
Ordered list, each item under a 2px accent top rule with a CSS-counter numeral in accent above a bold title and text-2 body.

### Mermaid diagrams
Neutral theme in light, dark theme in dark; the source is shown as mono text until drawn; wide diagrams scroll sideways.

### Scalar API reference
Scalar's background, text, accent, border, link and button variables are mapped from the VitePress variables. Light-mode method colours are darkened for 4.5:1 on the sidebar grey (green #05704c, blue #0b5cad, red #b3171c, orange #a83a00, yellow #7a5600). Sidebar toggle buttons have a 24px minimum target (WCAG 2.5.8).

## Do's and Don'ts

### Do:
- **Do** colour new chrome only from the `--vp-*` variables set in `custom.css`, and add dark values alongside light ones.
- **Do** keep the focus ring 2px accent, offset 2px.
- **Do** use the dark label on any dark-mode accent fill.
- **Do** separate sections with hairlines and put numbered order in accent numerals.

### Don't:
- **Don't** add feature-card grids, gradients, testimonials or invented screenshots or numbers to the start page.
- **Don't** import the Astryx stylesheet or load fonts, scripts or styles from other origins.
- **Don't** add shadows or a second accent hue.
- **Don't** change the body measure.
