import {defineTheme} from '@astryxdesign/core/theme';

const focusRing = {
  outline: 'var(--focus-outline-width) var(--focus-outline-style) var(--focus-outline-color)',
  outlineOffset: 'var(--focus-outline-offset)',
};
// A menu's rows sit edge to edge in a clipping box: their ring is drawn inside them.
const rowFocusRing = {...focusRing, outlineOffset: 'calc(var(--focus-outline-width) * -1)'};
// A field's ring is its border, thickened: one line on the field's own edge and radius, not a second box around it, and
// without the design system's faint inner ring beside it. The ring covers the border and the ring's full width inside
// it: over the grey border the ring's colour differs by less than 3:1, so a ring of only its width drew one line the eye
// can tell, and not every field showed all of it.
const fieldFocusRing = {
  ...focusRing,
  outlineWidth: 'calc(var(--focus-outline-width) + var(--border-width))',
  outlineOffset: 'calc(var(--border-width) * -1)',
  boxShadow: 'none',
};
const TOUCH = '44px';
// The one action a screen exists for, at every pointer.
const LARGE = '48px';
// The gate's minimum target for a mouse (WCAG 2.5.8).
const MOUSE_TARGET = '24px';
// Eneo's blue, light then dark: the default a deployment's own accent replaces (ORGANIZATION_ACCENT). The theme derives
// its accent scale from it, and the token below pins the colour itself. web-next's #1A6FD2 is 4.4:1 on the muted fill
// and 4.3:1 on its own tint (a tile's icon): this darker blue reaches 4.5:1 on every ground and on its tint
// (backend/app/accent.py, lib/accessibility.test.ts).
const ACCENT: [string, string] = ['#1563BC', '#52B1FF'];
// Figtree, Eneo's face (web-next): bundled from @fontsource-variable/figtree (main.tsx), a same-origin file.
const FONT = 'Figtree Variable';
const FALLBACKS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';

const DISABLED = ':is(:disabled, [aria-disabled="true"])';

export const eneoTheme = defineTheme({
  name: 'eneo',
  color: {accent: ACCENT, neutralStyle: 'neutral', contrast: 'standard'},
  typography: {
    scale: {base: 16, ratio: 1.2},
    body: {family: FONT, fallbacks: FALLBACKS},
    heading: {family: FONT, fallbacks: FALLBACKS},
    code: {family: 'ui-monospace', fallbacks: '"SFMono-Regular", Consolas, monospace'},
  },
  tokens: {
    '--color-accent': ACCENT,
    '--color-on-accent': ['#FFFFFF', '#06101C'],
    // The accent's tint (tiles, pills, "Senast använd"): primary text on it is 15:1 and 11:1.
    '--color-accent-muted': [
      'color-mix(in srgb, var(--color-accent) 10%, transparent)',
      'color-mix(in srgb, var(--color-accent) 16%, transparent)',
    ],
    // "Eneo, luftig": web-next's structure on a blue-white ground; dark surfaces lighten as they rise. These greys, the
    // hairlines and the shadows carry Eneo's blue: a deployment's accent gives them its own hue (backend/app/accent.py
    // NEUTRALS, which its tests hold to the built theme).
    '--color-background-body': ['#F4F7FB', '#070C16'],
    '--color-background-surface': ['#FFFFFF', '#0B1322'],
    '--color-background-card': ['#FFFFFF', '#0F1828'],
    '--color-background-popover': ['#FFFFFF', '#16213A'],
    '--color-background-muted': ['#EEF2F8', '#16213A'],
    '--color-background-inverted': ['#141A26', '#E4E9F0'],
    '--color-text-primary': ['#141A26', '#E4E9F0'],
    '--color-text-secondary': ['#4F5A6B', '#9AA8BC'],
    // Never used for content: a disabled control's words.
    '--color-text-disabled': ['#98A1AF', '#56637A'],
    '--color-icon-primary': ['#141A26', '#E4E9F0'],
    '--color-icon-secondary': ['#4F5A6B', '#9AA8BC'],
    '--color-icon-disabled': ['#98A1AF', '#56637A'],
    '--color-neutral': ['rgba(20, 40, 80, 0.07)', 'rgba(255, 255, 255, 0.08)'],
    '--color-overlay-hover': ['rgba(20, 40, 80, 0.045)', 'rgba(255, 255, 255, 0.05)'],
    '--color-overlay-pressed': ['rgba(20, 40, 80, 0.09)', 'rgba(255, 255, 255, 0.1)'],
    '--color-overlay': ['rgba(15, 18, 23, 0.4)', 'rgba(0, 0, 0, 0.6)'],
    // A decorative hairline; a control's edge is --color-border-emphasized.
    '--color-border': ['rgba(20, 40, 80, 0.08)', 'rgba(255, 255, 255, 0.07)'],
    '--color-success': ['#1E7A32', '#6CC382'],
    // A notice's fill keeps its status's hue in dark mode too: a mix into the blue card lost the yellow's to the blue,
    // so a warning read as a grey panel.
    '--color-success-muted': ['#E2F2E5', '#16291C'],
    '--color-warning': ['#8A5A00', '#E9B949'],
    '--color-warning-muted': ['#FCF0D4', '#2E2614'],
    '--color-error-muted': ['#FBE5E6', '#341A1E'],
    '--color-skeleton': ['#E6E9EE', '#242A32'],
    '--color-track': ['#DDE1E7', '#2C323B'],
    '--color-shadow': ['rgba(0, 0, 0, 0.08)', 'rgba(0, 0, 0, 0.4)'],
    // web-next's categorical hues, only those read: a tile's purple, teal and green (components/IconTile.tsx), where a
    // hue says what a thing is, never a hash of its name; and the yellow of a "not sure" token.
    '--color-icon-purple': ['#6D46B8', '#B99AF5'],
    '--color-background-purple': ['#EEE7FA', 'rgba(185, 154, 245, 0.16)'],
    '--color-icon-teal': ['#0B6E69', '#52D1C6'],
    '--color-background-teal': ['#DCF2EF', 'rgba(82, 209, 198, 0.14)'],
    '--color-icon-green': ['#1E7A32', '#6CC382'],
    '--color-background-green': ['#E2F2E5', 'rgba(108, 195, 130, 0.15)'],
    '--color-text-yellow': ['#8A5A00', '#E9B949'],
    '--color-icon-yellow': ['#8A5A00', '#E9B949'],
    '--color-background-yellow': ['#FCF0D4', 'rgba(233, 185, 73, 0.15)'],
    // Concentric: a card 16 px, a row or well in it 12 px, a control 10 px.
    '--radius-inner': '0.375rem',
    '--radius-element': '0.625rem',
    '--radius-container': '1rem',
    '--radius-page': '1.25rem',
    // Edge or shadow, never both: a soft drop in light mode; in dark mode, where a drop does not show on the near-black
    // page, an edge instead. A card and a popover draw that edge as their border (`card` and `popover` below); what floats
    // without one (a dialog) has it from its shadow, a one-pixel rim of light.
    '--shadow-low':
      '0 1px 2px light-dark(rgba(16, 40, 80, 0.04), transparent), ' +
      '0 6px 20px -6px light-dark(rgba(16, 40, 80, 0.08), transparent)',
    '--shadow-med':
      '0 2px 4px light-dark(rgba(16, 40, 80, 0.05), transparent), ' +
      '0 16px 40px -12px light-dark(rgba(16, 40, 80, 0.12), transparent), ' +
      'inset 0 0 0 1px light-dark(transparent, rgba(255, 255, 255, 0.07))',
    '--shadow-high':
      '0 4px 8px light-dark(rgba(0, 0, 0, 0.08), transparent), ' +
      '0 24px 56px light-dark(rgba(0, 0, 0, 0.2), transparent), ' +
      'inset 0 0 0 1px light-dark(transparent, rgba(255, 255, 255, 0.09))',
    // Astryx's default white label on the dark-mode error fill is 3.76:1; a dark label is 5.4:1.
    '--color-on-error': ['#FFFFFF', '#1A0A0C'],
    // Arrival titles ("Välj ett flöde", a flow's name): 28 px on a phone to 40 px on a wide screen, bold. In rem and vw,
    // so they still follow the reader's text size. State titles (h1) and sections (h2) are bold as well.
    '--text-display-3-size': 'clamp(1.75rem, 1.35rem + 1.6vw, 2.5rem)',
    '--text-display-3-weight': 'var(--font-weight-bold)',
    '--text-display-3-leading': '1.15',
    '--text-heading-1-weight': 'var(--font-weight-bold)',
    '--text-heading-2-weight': 'var(--font-weight-bold)',
    // A label leads what it names: semibold (the status over the recording's clock, a context line over a title).
    '--text-label-weight': 'var(--font-weight-semibold)',
    // The one action a screen exists for (Starta, Stoppa, Skapa dokument) is 48 px at every pointer; Astryx's
    // large control is 36 px with a mouse.
    '--size-element-lg': LARGE,
    // Descriptions, help under a label and lines under an action are read, not glanced at: 14 px, not the scale's 13.
    '--font-size-sm': '0.875rem',
    // Error text is 4.1:1 on the page's grey in Astryx's red, and that red is the recording dot's (1.0:1 and 1.25:1
    // apart): an error never looks like "recording".
    '--color-error': ['#AA181D', '#F47B7F'],
    // A control's edge: 3:1 on every ground (WCAG 1.4.11).
    '--color-border-emphasized': ['#758093', '#6E7E96'],
  },
  components: {
    // The page rests on the body colour (ModuleShell's "wash" variant); the bar above it is the surface, as web-next's.
    'app-shell-header': {base: {backgroundColor: 'var(--color-background-surface)'}},
    // Edge or shadow, never both: a white card on the tinted ground has the soft drop in light mode and its hairline in
    // dark mode, where --shadow-low has no drop. A muted card is not lifted: it keeps its edge in both.
    card: {
      base: {boxShadow: 'var(--shadow-low)', borderColor: 'light-dark(transparent, var(--color-border))'},
      'variant:muted': {boxShadow: 'none', borderColor: 'var(--color-border)'},
    },
    // A popover (a menu, a picker's list) floats on --shadow-low as a card does, and has its edge in dark mode as a card
    // does.
    popover: {base: {border: 'var(--border-width) solid light-dark(transparent, var(--color-border))'}},
    // A notice sits in a card as a row does: the card's radius less its inset; its colours stay the status tokens.
    banner: {base: {borderRadius: 'calc(var(--radius-container) - var(--spacing-1))'}},
    // A field's label leads: semibold in the primary colour. Its description stays 14 px and secondary, and its last line
    // keeps more than one word (the field's words inherit it: the description has no class of its own).
    field: {base: {textWrap: 'pretty'}},
    // Its "∙ Valfritt" goes under the label where the reader's large text leaves no room beside it, not past the card.
    'field-label': {base: {fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-primary)', flexWrap: 'wrap'}},
    // A word with no break point (an e-mail address as a name, a long compound) wraps instead of reaching past a
    // 320 px screen: Astryx breaks words only when it truncates.
    // A heading that wraps balances its lines: "Dokumentet kunde inte skapas" does not leave "skapas" alone on a phone.
    // A long Swedish compound in a heading is hyphenated where the browser knows the language (the page is lang="sv"):
    // "Samtalssamman-ställning", not "Samtalssammanställnin|g" in the flow's 20rem column.
    // A phase's heading takes focus when its view appears (usePhaseHeading) but is no control: the browser counts that
    // focus call as keyboard focus and would frame the headline on every visit.
    // Display and state titles are set a little tighter, as a bold face at their size wants.
    // Only a word of 8 letters or more is hyphenated, 3 or more on each side: "Dokumentet kunde inte skapas" breaks
    // between words, never "kun-de" (Firefox, and Chromium on Windows and Android, hyphenated a five-letter word).
    heading: {
      base: {overflowWrap: 'anywhere', hyphens: 'auto', hyphenateLimitChars: '8 3 3', textWrap: 'balance', ':focus-visible': {outline: 'none'}},
      'level:1': {letterSpacing: '-0.01em'},
      'type:display-3': {letterSpacing: '-0.02em'},
    },
    text: {base: {overflowWrap: 'anywhere'}},
    'text-input': {base: {':focus-within': fieldFocusRing}},
    'text-area': {base: {':focus-within': fieldFocusRing}},
    'number-input': {base: {':focus-within': fieldFocusRing}},
    // The value's line is the design system's --spacing-5 (20 px) at the default root, in rem: in px it cut the value's
    // words in half at the reader's own large text (iOS's accessibility sizes, WCAG 1.4.4).
    selector: {base: {':focus-within': fieldFocusRing, lineHeight: '1.25rem'}},
    typeahead: {base: {':focus-within': fieldFocusRing}},
    tokenizer: {base: {':focus-within': fieldFocusRing}},
    // The radio rows of a menu show no focus at all (a plain row tints, a radio row does not).
    'dropdown-menu-item': {base: {':focus-visible': rowFocusRing}},
    // A long compound word or e-mail address wraps inside its row instead of being cut off by it.
    item: {base: {overflowWrap: 'anywhere'}},
    // A result's prose, as the page's own text: a long address wraps inside the column instead of reaching past a 320 px screen.
    // A long word (10 letters or more, a Swedish compound) that ends a line is hyphenated, as a heading's is: with the
    // reader's large text it was otherwise broken mid-syllable ("budgetrame|n").
    markdown: {base: {overflowWrap: 'anywhere', hyphens: 'auto', hyphenateLimitChars: '10 4 4'}},
    // A table's header cells keep one line and cut the rest off with an ellipsis, where the cells under them wrap: a
    // heading such as "Belopp, tkr" loses its unit on a phone (WCAG 1.4.10).
    'table-header-cell': {base: {whiteSpace: 'normal', textOverflow: 'clip', overflowWrap: 'break-word', wordBreak: 'break-word'}},
    // Scroll shadows reveal that a narrow table has more columns, without another control or wrapper.
    'table-scroll-wrapper': {base: {
      backgroundImage: 'linear-gradient(to right, var(--color-background-card), transparent), linear-gradient(to left, var(--color-background-card), transparent), radial-gradient(farthest-side at 0 50%, var(--color-border), transparent), radial-gradient(farthest-side at 100% 50%, var(--color-border), transparent)',
      backgroundPosition: 'left center, right center, left center, right center',
      backgroundSize: 'var(--spacing-6) 100%, var(--spacing-6) 100%, var(--spacing-2) 100%, var(--spacing-2) 100%',
      backgroundRepeat: 'no-repeat',
      backgroundAttachment: 'local, local, scroll, scroll',
    }},
    // A step's name keeps one line and is cut off with an ellipsis, with its state words beside it pushed out of the
    // card (WCAG 1.4.10): a flow's step names are its author's, as long as they like. It wraps, and the words follow it.
    'step-label': {base: {whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip', overflowWrap: 'anywhere'}},
    // A step's state is its icon (the spinner, a check, a cross) and its word, not a bar: the design system's accent bar
    // also marked the step that stopped a run, in the colour of what is under way.
    'step-bar': {base: {display: 'none'}},
    // A step's icon stands on the content's edge, under the heading's first letter: the design system pads each step's
    // row 8 px in at both sides (a clickable step's hover target, at the default density), and that padding is laid
    // outside the column, as a radio row's is.
    stepper: {'orientation:vertical': {marginInline: 'calc(-1 * var(--spacing-2))', width: 'calc(100% + 2 * var(--spacing-2))'}},
    // A token's height gives way to the text spacing a reader may set (WCAG 1.4.12) instead of cutting its words. Only a
    // removable chip is a control's height: its remove button reaches a 44 px target through a pseudo-element, which the
    // chip must not clip. A pill that only says something (Senast använd, Osäkert förslag) keeps its words' height at every
    // pointer, so it never looks like a button beside one, with a little room above and below its words inside its fill.
    // The blue token is the brand's tint, not the data palette's blue, and a pill: it follows the deployment's accent
    // colour (ORGANIZATION_ACCENT), with the primary text colour on it, which keeps its contrast whatever the accent is.
    token: {
      base: {
        overflow: 'visible',
        height: 'auto',
        paddingBlock: 'var(--spacing-0-5)',
        ':has(button)': {minHeight: 'calc(var(--size-element-md) - var(--spacing-2))'},
      },
      'color:blue': {backgroundColor: 'var(--color-accent-muted)', color: 'var(--color-text-primary)', borderRadius: 'var(--radius-full)'},
    },
    // Tabs that do not fit beside each other (the reader's large text, a phone's zoom) stand in rows, each with its words
    // whole and hyphenated where one is longer than the row: the design system's strip scrolled them sideways and cut
    // the one not chosen at the window's edge.
    'tab-strip': {base: {flexWrap: 'wrap'}},
    tab: {base: {whiteSpace: 'normal', height: 'auto', minHeight: 'var(--size-element-md)', overflowWrap: 'break-word', hyphens: 'auto'}},
    // The position slider's unplayed track is a control's edge colour: 3:1 on the card (WCAG 1.4.11), so where the
    // recording ends shows at its start. The design system's track (--color-track) is 1.3:1; the level meter and the
    // upload's bar keep that token, beside words that say the same.
    'slider-track': {base: {backgroundColor: 'var(--color-border-emphasized)'}},
    // The control is the slider's target (the track is 4 px, the thumb 20): the gate's 24 px, and 44 px below.
    'slider-control': {base: {minBlockSize: MOUSE_TARGET}},
    // A row of chips wraps instead of reaching past a 320 px screen: the group is one inline line. Chips stand 8 px apart
    // at every pointer: a tap meant for one does not land on the next, and with a mouse they read as separate filters.
    'toggle-button-group': {base: {flexWrap: 'wrap', gap: 'var(--spacing-2)'}},
    // A chip (the transcript's speaker filter) is a ghost button, which shows no edge at rest: only the pressed one had a
    // shape. Each has a control's edge, and the pressed one the accent's edge. Astryx owns the fill and its matching
    // label colour so the selected state also keeps their system-colour pair in forced colours. The
    // edge is drawn inside the chip, so no chip changes size (forced colours give every button its own edge, globals.css).
    // The pressed state is read from aria-pressed: the theme's `isPressed` target writes a value the button never carries.
    'toggle-button': {
      base: {
        boxShadow: 'inset 0 0 0 var(--border-width) var(--color-border-emphasized)',
        ':is([aria-pressed="true"])': {
          boxShadow: 'inset 0 0 0 var(--border-width) var(--color-accent)',
        },
      },
    },
    // One choice of a few (the setup's modes, a passage's speaker) is a row the whole of which is the target, with no box
    // of its own: a bordered row in a card read as a card in the card. Its radio stands on the content's edge, under the
    // heading's first letter, and its padding outside the column, so the chosen row's tint reaches past its words. The
    // chosen row is tinted and its radio filled; in dark mode the tint is stronger, as 8 % of the accent is 1.14:1 on
    // the card there and barely reads.
    'radio-list': {'orientation:vertical': {gap: 'var(--spacing-1)'}},
    'radio-list-item': {
      base: {
        boxSizing: 'border-box',
        paddingBlock: 'var(--spacing-3)',
        paddingInline: 'var(--spacing-3)',
        marginInline: 'calc(-1 * var(--spacing-3))',
        // A row inside a card: the card's radius less its inset.
        borderRadius: 'calc(var(--radius-container) - var(--spacing-1))',
        // The radio stands at the name's line, not halfway down a description of three or four lines on a phone.
        alignItems: 'flex-start',
        ':has(:focus-visible)': focusRing,
      },
      selected: {
        backgroundColor:
          'light-dark(color-mix(in srgb, var(--color-accent) 8%, transparent), color-mix(in srgb, var(--color-accent) 14%, transparent))',
      },
    },
    // A label longer than its line wraps and the button grows with it: the design system keeps one line, cuts the rest
    // off with an ellipsis and fixes the height (WCAG 1.4.10 reflow at 320 px, 1.4.4 resize at 200 %). The block padding
    // is small enough that a one-line label still fills the size's own height: 28, 32 and 36 px.
    // A button after the field in an input group (the participants' Lägg till) is one piece with it, as the group's own
    // addons are: square where they meet. The design system squares the field's corners there, not the button's.
    // A word longer than the button (the reader's large text: "mikrofonen") is hyphenated where the page's language
    // allows, and broken where it does not, rather than cut off with an ellipsis.
    button: {
      base: {
        whiteSpace: 'normal',
        overflowWrap: 'break-word',
        hyphens: 'auto',
        height: 'auto',
        minHeight: 'var(--size-element-md)',
        paddingBlock: 'var(--spacing-0-5)',
        ':is(.astryx-input-group > :not(:first-child))': {borderStartStartRadius: '0', borderEndStartRadius: '0'},
      },
      'size:sm': {minHeight: 'var(--size-element-sm)'},
      'size:lg': {minHeight: 'var(--size-element-lg)'},
      // The primary is the design system's own: a flat fill of the accent, with its own hover and press overlays.
      // Outlined, never a grey slab: the card's colour inside a control's edge. Disabled keeps a hairline and the disabled
      // text colour, at full opacity, so it is not read as a grey block either.
      'variant:secondary': {
        backgroundColor: 'var(--color-background-card)',
        boxShadow: 'inset 0 0 0 var(--border-width) var(--color-border-emphasized)',
        color: 'var(--color-text-primary)',
        [DISABLED]: {
          opacity: '1',
          color: 'var(--color-text-disabled)',
          boxShadow: 'inset 0 0 0 var(--border-width) var(--color-border)',
        },
        // Joined to a field (the participants' Lägg till, off until a name is typed), it keeps the field's own edge, so
        // the two read as one control and not as a field cut off; its words alone say that it waits.
        [`:is(.astryx-input-group > *)${DISABLED}`]: {boxShadow: 'inset 0 0 0 var(--border-width) var(--color-border-emphasized)'},
      },
    },
    // The initials sit on a tint of the neutral colour; the secondary text colour on it, over the page's surface, is
    // 4.28:1 in dark mode, the primary one 8.5:1.
    'avatar-fallback': {base: {color: 'var(--color-text-primary)'}},
    // An off switch's track is a control's edge colour: 3:1 on the page and under its thumb (WCAG 1.4.11); the design
    // system's translucent grey is 1.5:1. Set as the grey the switch's own off, hover and disabled rules read, so its on
    // track and its forced-colours tracks stay the design system's.
    switch: {base: {'--color-background-gray': 'var(--color-border-emphasized)'}},
    // A dialog opens over the medium band's longest step (--duration-medium-max, 550 ms), which reads as the page
    // catching up with the press: the fast band's longest is enough to show where it came from. A dialog that has the
    // focus itself (Firefox and Safari stop on it, Shift+Tab from its first control) rings itself inside its edge, on its
    // own surface: outside it the ring stands on the dimmed page, which the accent is not checked against (Eneo's blue
    // changes it by less than 3:1 there).
    dialog: {base: {animationDuration: 'var(--duration-fast-max)', ':focus-visible': rowFocusRing}},
    // The trigger is one line of 13 px text, 19 px tall: the gate's 24 px (WCAG 2.5.8).
    // A disclosure is quieter than the headings around it: body size and medium weight, not the design system's large
    // semibold row.
    'collapsible-trigger': {base: {minHeight: MOUSE_TARGET, fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-medium)'}},
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
            // A one-line correction can shrink to 32 px on a tablet. The field itself remains a touch target.
            'text-area-control': {base: {minBlockSize: TOUCH}},
          },
        },
      },
    ],
  },
});
