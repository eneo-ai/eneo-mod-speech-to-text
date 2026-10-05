import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'
import { localizeHtml } from './theme/labels'

const docs = fileURLToPath(new URL('../../docs/', import.meta.url))
const here = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url))

// The accent and the foreground on it come from frontend/kit/theme/eneo.theme.ts (light, dark).
const ACCENT = { light: '#004595', dark: '#52B1FF' }

/** The mark as a data URI in one colour: images cannot follow the page's colour, so there is one per mode. */
const mark = (colour: string) =>
  `data:image/svg+xml,${encodeURIComponent(readFileSync(here('mark.svg'), 'utf8').replace('currentColor', colour))}`

/** The start page's picture: a voice that turns into lines of text. The lines are a quiet tone of the same blue. */
const hero = (bars: string, lines: string) =>
  `data:image/svg+xml,${encodeURIComponent(readFileSync(here('hero.svg'), 'utf8').replace('{bars}', bars).replace('{lines}', lines))}`

/** The decision pages, each named by its own first heading ("0004. Native dialoger …" becomes "0004 Native dialoger …"). */
function decisions() {
  return readdirSync(`${docs}decisions`)
    .filter((file) => /^\d{4}-.*\.md$/.test(file))
    .sort()
    .map((file) => {
      const title = readFileSync(`${docs}decisions/${file}`, 'utf8').match(/^# (.+)$/m)?.[1] ?? file
      return { text: title.replace(/^(\d{4})\.\s*/, '$1 '), link: `/decisions/${file.replace(/\.md$/, '')}` }
    })
}

export default defineConfig({
  lang: 'sv-SE',
  title: 'Tal till text',
  titleTemplate: ':title · Tal till text',
  description: 'Dokumentationen för Tal till text, en Eneo-modul som gör text av inspelade samtal och ljudfiler.',
  base: '/eneo-mod-speech-to-text/',
  cleanUrls: true,
  srcDir: '../docs',
  srcExclude: ['plans/**'],
  rewrites: { 'decisions/README.md': 'decisions/index.md' },
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: mark(ACCENT.light) }]],
  markdown: {
    config(md) {
      // A diagram is plain text in the page; theme/diagrams.ts renders it in the browser, on the pages that have one.
      const fence = md.renderer.rules.fence!
      md.renderer.rules.fence = (tokens, idx, options, env, self) =>
        tokens[idx].info.trim() === 'mermaid'
          ? `<pre class="mermaid" v-pre>${md.utils.escapeHtml(tokens[idx].content)}</pre>\n`
          : fence(tokens, idx, options, env, self)
    },
  },
  vite: {
    // The pages live in ../docs, outside this package: their compiled modules would not find vue next to themselves.
    resolve: { alias: [{ find: /^vue(\/.*)?$/, replacement: `${here('node_modules/vue')}$1` }] },
  },

  themeConfig: {
    logo: { light: mark(ACCENT.light), dark: mark(ACCENT.dark), alt: '' },
    siteTitle: 'Tal till text',
    nav: [
      { text: 'Start', link: '/' },
      { text: 'API-referens', link: '/api-referens' },
    ],
    sidebar: [
      { text: 'Om modulen', items: [{ text: 'Start', link: '/' }] },
      {
        text: 'Drift',
        items: [
          { text: 'Drift', link: '/operations' },
          { text: 'Byt organisation', link: '/branding' },
        ],
      },
      {
        text: 'Utveckling',
        items: [
          { text: 'Lokal utveckling', link: '/development' },
          { text: 'Tester', link: '/quality-gates' },
        ],
      },
      {
        text: 'Teknisk referens',
        items: [
          { text: 'API-referens', link: '/api-referens' },
          { text: 'Arkitektur', link: '/architecture' },
          { text: 'Inloggning och session', link: '/auth-and-session' },
          { text: 'Eneo-integration', link: '/eneo-integration' },
          { text: 'Backend', link: '/backend' },
          { text: 'Frontend', link: '/frontend' },
          { text: 'Inspelaren', link: '/recording' },
        ],
      },
      { text: 'Beslut', link: '/decisions/', items: decisions(), collapsed: true },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/eneo-ai/eneo-mod-speech-to-text', ariaLabel: 'Källkod på GitHub' }],
    footer: { message: 'Licens: AGPL-3.0-only, samma som Eneo.' },

    outline: { label: 'På den här sidan', level: [2, 3] },
    docFooter: { prev: 'Föregående sida', next: 'Nästa sida' },
    sidebarMenuLabel: 'Meny',
    returnToTopLabel: 'Till toppen',
    skipToContentLabel: 'Hoppa till innehållet',
    darkModeSwitchLabel: 'Utseende',
    lightModeSwitchTitle: 'Byt till ljust läge',
    darkModeSwitchTitle: 'Byt till mörkt läge',
    langMenuLabel: 'Byt språk',
    externalLinkIcon: true,
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: 'Sök', buttonAriaLabel: 'Sök i dokumentationen' },
          modal: {
            displayDetails: 'Visa detaljer',
            resetButtonTitle: 'Rensa sökningen',
            backButtonTitle: 'Stäng sökningen',
            noResultsText: 'Inga träffar för',
            footer: {
              selectText: 'välj',
              selectKeyAriaLabel: 'Retur',
              navigateText: 'bläddra',
              navigateUpKeyAriaLabel: 'Pil upp',
              navigateDownKeyAriaLabel: 'Pil ner',
              closeText: 'stäng',
              closeKeyAriaLabel: 'Esc',
            },
          },
        },
      },
    },
    notFound: {
      title: 'Sidan finns inte',
      quote: 'Adressen leder ingenstans. Gå till startsidan eller sök efter det du letar efter.',
      linkLabel: 'Till startsidan',
      linkText: 'Till startsidan',
      code: '404',
    },
  },

  transformHtml: localizeHtml,

  transformPageData(page) {
    // The start page's picture lives beside the config, not in docs/, so it is attached here.
    if (page.relativePath === 'index.md' && page.frontmatter.hero) {
      page.frontmatter.hero.image = { light: hero(ACCENT.light, '#b9c4d8'), dark: hero(ACCENT.dark, '#3a4659'), alt: '' }
    }
  },
})
