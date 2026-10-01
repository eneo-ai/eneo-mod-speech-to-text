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
          },
        },
      },
    ],
  },
});
