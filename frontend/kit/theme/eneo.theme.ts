import {defineTheme} from '@astryxdesign/core/theme';

const focusRing = {
  outline: 'var(--focus-outline-width) var(--focus-outline-style) var(--focus-outline-color)',
  outlineOffset: 'var(--focus-outline-offset)',
};
// A menu's rows sit edge to edge in a clipping box: their ring is drawn inside them.
const rowFocusRing = {...focusRing, outlineOffset: 'calc(var(--focus-outline-width) * -1)'};
// A field's ring is its border, thickened: one line on the field's own edge and radius, not a second box around it, and
// without the design system's faint inner ring beside it.
const fieldFocusRing = {...focusRing, outlineOffset: 'calc(var(--border-width) * -1)', boxShadow: 'none'};
const TOUCH = '44px';
// The one action a screen exists for, at every pointer.
const LARGE = '48px';
// The gate's minimum target for a mouse (WCAG 2.5.8).
const MOUSE_TARGET = '24px';
// The brand's blue, light then dark. The theme derives its accent scale from it, and the token below pins the colour itself.
const ACCENT: [string, string] = ['#004595', '#52B1FF'];

export const eneoTheme = defineTheme({
  name: 'eneo',
  color: {accent: ACCENT, neutralStyle: 'neutral', contrast: 'standard'},
  typography: {
    scale: {base: 16, ratio: 1.2},
    body: {family: 'system-ui', fallbacks: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif'},
    code: {family: 'ui-monospace', fallbacks: '"SFMono-Regular", Consolas, monospace'},
  },
  tokens: {
    '--color-accent': ACCENT,
    '--color-on-accent': ['#FFFFFF', '#0B1118'],
    // Astryx's default white label on the dark-mode error fill is 3.76:1; a dark label is 5.4:1.
    '--color-on-error': ['#FFFFFF', '#1A0A0C'],
    // The one action a screen exists for (Starta, Stoppa, Skapa dokument) is 48 px at every pointer; Astryx's
    // large control is 36 px with a mouse.
    '--size-element-lg': LARGE,
    // Error text is 4.1:1 on the page's grey in Astryx's red, and that red is the recording dot's (1.0:1 and 1.25:1
    // apart): an error never looks like "recording".
    '--color-error': ['#AA181D', '#F47B7F'],
    // A control's edge is 2.8:1 on the page and on a muted fill in light mode; 3:1 is the floor (WCAG 1.4.11).
    '--color-border-emphasized': ['#85868F', '#626972'],
  },
  components: {
    // A word with no break point (an e-mail address as a name, a long compound) wraps instead of reaching past a
    // 320 px screen: Astryx breaks words only when it truncates.
    // A phase's heading takes focus when its view appears (usePhaseHeading) but is no control: the browser counts that
    // focus call as keyboard focus and would frame the headline on every visit.
    heading: {base: {overflowWrap: 'anywhere', ':focus-visible': {outline: 'none'}}},
    text: {base: {overflowWrap: 'anywhere'}},
    'text-input': {base: {':focus-within': fieldFocusRing}},
    'text-area': {base: {':focus-within': fieldFocusRing}},
    'number-input': {base: {':focus-within': fieldFocusRing}},
    selector: {base: {':focus-within': fieldFocusRing}},
    typeahead: {base: {':focus-within': fieldFocusRing}},
    tokenizer: {base: {':focus-within': fieldFocusRing}},
    // The radio rows of a menu show no focus at all (a plain row tints, a radio row does not).
    'dropdown-menu-item': {base: {':focus-visible': rowFocusRing}},
    // A long compound word or e-mail address wraps inside its row instead of being cut off by it.
    item: {base: {overflowWrap: 'anywhere'}},
    // A removable chip: its remove button reaches a 44 px target through a pseudo-element, which the chip must not
    // clip, and its height gives way to the text spacing a reader may set (WCAG 1.4.12) instead of cutting the name.
    // The blue token is the brand's tint, not the data palette's blue: it follows the deployment's accent colour
    // (ORGANIZATION_ACCENT), with the primary text colour on it, which keeps its contrast whatever the accent is.
    token: {
      base: {overflow: 'visible', height: 'auto', minHeight: 'calc(var(--size-element-md) - var(--spacing-2))'},
      'color:blue': {backgroundColor: 'var(--color-accent-muted)', color: 'var(--color-text-primary)'},
    },
    // The control is the slider's target (the track is 4 px, the thumb 20): the gate's 24 px, and 44 px below.
    'slider-control': {base: {minBlockSize: MOUSE_TARGET}},
    // A row of chips wraps instead of reaching past a 320 px screen: the group is one inline line.
    'toggle-button-group': {base: {flexWrap: 'wrap'}},
    // A dialog opens on its title (the title takes focus, which gives it no outline): where focus is on it, as on
    // a keyboard's, its block shows the ring (WCAG 2.4.7).
    'dialog-header-title-block': {base: {':has(:focus-visible)': focusRing}},
    // A label longer than its line wraps and the button grows with it: the design system keeps one line, cuts the rest
    // off with an ellipsis and fixes the height (WCAG 1.4.10 reflow at 320 px, 1.4.4 resize at 200 %). The block padding
    // is small enough that a one-line label still fills the size's own height: 28, 32 and 36 px.
    // A button after the field in an input group (the participants' Lägg till) is one piece with it, as the group's own
    // addons are: square where they meet. The design system squares the field's corners there, not the button's.
    button: {
      base: {
        whiteSpace: 'normal',
        height: 'auto',
        minHeight: 'var(--size-element-md)',
        paddingBlock: 'var(--spacing-0-5)',
        ':is(.astryx-input-group > :not(:first-child))': {borderStartStartRadius: '0', borderEndStartRadius: '0'},
      },
      'size:sm': {minHeight: 'var(--size-element-sm)'},
      'size:lg': {minHeight: 'var(--size-element-lg)'},
    },
    // The initials sit on a tint of the neutral colour; the secondary text colour on it, over the page's surface, is
    // 4.28:1 in dark mode, the primary one 8.5:1.
    'avatar-fallback': {base: {color: 'var(--color-text-primary)'}},
    // The trigger is one line of 13 px text, 19 px tall: the gate's 24 px (WCAG 2.5.8).
    'collapsible-trigger': {base: {minHeight: MOUSE_TARGET}},
  },
  adaptations: {
    rules: [
      {
        when: {pointer: 'coarse'},
        value: {
          tokens: {'--size-element-sm': TOUCH, '--size-element-md': TOUCH, '--size-element-lg': LARGE},
          components: {
            'dropdown-menu-item': {base: {minHeight: TOUCH}},
            'selector-option-row': {base: {minHeight: TOUCH}},
            'typeahead-item': {base: {minHeight: TOUCH}},
            'top-nav-heading': {base: {minHeight: TOUCH}},
            'slider-control': {base: {minBlockSize: TOUCH}},
            'collapsible-trigger': {base: {minHeight: TOUCH}},
            'radio-list-item': {base: {minHeight: TOUCH}},
          },
        },
      },
    ],
  },
});
