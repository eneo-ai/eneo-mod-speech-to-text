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
  },
  components: {
    // A word with no break point (an e-mail address as a name, a long compound) wraps instead of reaching past a
    // 320 px screen: Astryx breaks words only when it truncates.
    heading: {base: {overflowWrap: 'anywhere'}},
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
    // The initials sit on a tint of the neutral colour; the secondary text colour on it, over the page's surface, is
    // 4.28:1 in dark mode, the primary one 8.5:1.
    'avatar-fallback': {base: {color: 'var(--color-text-primary)'}},
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
            'collapsible-trigger': {base: {minHeight: TOUCH}},
          },
        },
      },
    ],
  },
});
