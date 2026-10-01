import {defineTheme} from '@astryxdesign/core/theme';

const focusRing = {
  outline: 'var(--focus-outline-width) var(--focus-outline-style) var(--focus-outline-color)',
  outlineOffset: 'var(--focus-outline-offset)',
};
// A menu's rows sit edge to edge in a clipping box: their ring is drawn inside them.
const rowFocusRing = {...focusRing, outlineOffset: 'calc(var(--focus-outline-width) * -1)'};
const TOUCH = '44px';

export const eneoTheme = defineTheme({
  name: 'eneo',
  color: {accent: ['#004595', '#52B1FF'], neutralStyle: 'neutral', contrast: 'standard'},
  typography: {
    scale: {base: 16, ratio: 1.2},
    body: {family: 'system-ui', fallbacks: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif'},
    code: {family: 'ui-monospace', fallbacks: '"SFMono-Regular", Consolas, monospace'},
  },
  tokens: {
    '--color-accent': ['#004595', '#52B1FF'],
    '--color-on-accent': ['#FFFFFF', '#0B1118'],
    // Astryx's default white label on the dark-mode error fill is 3.76:1; a dark label is 5.4:1.
    '--color-on-error': ['#FFFFFF', '#1A0A0C'],
    // The one action a screen exists for (Starta, Stoppa, Skapa dokument) is 48 px at every pointer; Astryx's
    // large control is 36 px with a mouse.
    '--size-element-lg': '48px',
  },
  components: {
    // A word with no break point (an e-mail address as a name, a long compound) wraps instead of reaching past a
    // 320 px screen: Astryx breaks words only when it truncates.
    // A phase's heading takes focus when its view appears (usePhaseHeading) but is no control: the browser counts that
    // focus call as keyboard focus and would frame the headline on every visit.
    heading: {base: {overflowWrap: 'anywhere', ':focus-visible': {outline: 'none'}}},
    text: {base: {overflowWrap: 'anywhere'}},
    'text-input': {base: {':focus-within': focusRing}},
    'text-area': {base: {':focus-within': focusRing}},
    'number-input': {base: {':focus-within': focusRing}},
    selector: {base: {':focus-within': focusRing}},
    typeahead: {base: {':focus-within': focusRing}},
    tokenizer: {base: {':focus-within': focusRing}},
    // The radio rows of a menu show no focus at all (a plain row tints, a radio row does not).
    'dropdown-menu-item': {base: {':focus-visible': rowFocusRing}},
    // A long compound word or e-mail address wraps inside its row instead of being cut off by it.
    item: {base: {overflowWrap: 'anywhere'}},
    // The control is the slider's target (the track is 4 px, the thumb 20): the gate's 24 px, and 44 px below.
    'slider-control': {base: {minBlockSize: '24px'}},
    // A label longer than its line wraps and the button grows with it: the design system keeps one line, cuts the rest
    // off with an ellipsis and fixes the height (WCAG 1.4.10 reflow at 320 px, 1.4.4 resize at 200 %). The block padding
    // is small enough that a one-line label still fills the size's own height: 28, 32 and 36 px.
    button: {
      base: {whiteSpace: 'normal', height: 'auto', minHeight: 'var(--size-element-md)', paddingBlock: 'var(--spacing-0-5)'},
      'size:sm': {minHeight: 'var(--size-element-sm)'},
      'size:lg': {minHeight: 'var(--size-element-lg)'},
    },
  },
  adaptations: {
    rules: [
      {
        when: {pointer: 'coarse'},
        value: {
          tokens: {'--size-element-sm': TOUCH, '--size-element-md': TOUCH, '--size-element-lg': '48px'},
          components: {
            'dropdown-menu-item': {base: {minHeight: TOUCH}},
            'selector-option-row': {base: {minHeight: TOUCH}},
            'typeahead-item': {base: {minHeight: TOUCH}},
            'top-nav-heading': {base: {minHeight: TOUCH}},
            'slider-control': {base: {minBlockSize: TOUCH}},
            'collapsible-trigger': {base: {minHeight: TOUCH}},
          },
        },
      },
    ],
  },
});
