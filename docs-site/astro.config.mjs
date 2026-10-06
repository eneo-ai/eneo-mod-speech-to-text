import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import md3Theme from 'starlight-theme-md3'
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi'
import { unified } from '@astrojs/markdown-remark'
import { docsHtml } from './scripts/docs-html.mjs'
import { apiLocale } from './scripts/localize-api.mjs'
import { sourceContent } from './scripts/prepare-content.mjs'

export default defineConfig({
  site: 'https://eneo-ai.github.io',
  base: '/eneo-mod-speech-to-text',
  trailingSlash: 'always',
  markdown: {
    processor: unified({ rehypePlugins: [docsHtml] }),
  },
  integrations: [sourceContent(), apiLocale(), starlight({
    title: 'Tal till text',
    description: 'Dokumentation för Eneo-modulen som gör text av inspelade samtal och ljudfiler.',
    defaultLocale: 'root',
    titleDelimiter: '·',
    locales: { root: { label: 'Svenska', lang: 'sv' } },
    customCss: ['./src/styles/custom.css'],
    expressiveCode: { themes: ['github-dark-high-contrast', 'github-light-high-contrast'] },
    components: { Head: './src/components/Head.astro', Footer: './src/components/Footer.astro' },
    social: [{ icon: 'github', label: 'Källkod på GitHub', href: 'https://github.com/eneo-ai/eneo-mod-speech-to-text' }],
    plugins: [md3Theme({
      accent: 'blue',
      density: 'comfortable',
      contrast: 'high',
      motion: false,
    }), starlightOpenAPI([{
      base: 'api',
      schema: '../docs/api/openapi.json',
      sidebar: { label: 'API-anrop', collapsed: true },
      snippets: { operation: false },
    }])],
    sidebar: [
      { label: 'Om modulen', items: [{ label: 'Start', link: '/' }] },
      { label: 'Driftsättning', items: [
        { label: 'Drift', link: '/operations/' },
        { label: 'Byt organisation', link: '/branding/' },
      ] },
      { label: 'Utveckling', items: [
        { label: 'Lokal utveckling', link: '/development/' },
        { label: 'Tester', link: '/quality-gates/' },
      ] },
      { label: 'Teknisk referens', items: [
        { label: 'API-referens', link: '/api-referens/' },
        { label: 'Arkitektur', link: '/architecture/' },
        { label: 'Inloggning och session', link: '/auth-and-session/' },
        { label: 'Eneo-integration', link: '/eneo-integration/' },
        { label: 'Backend', link: '/backend/' },
        { label: 'Frontend', link: '/frontend/' },
        { label: 'Inspelaren', link: '/recording/' },
      ] },
      { label: 'Beslut', items: [{ autogenerate: { directory: 'decisions' } }] },
      ...openAPISidebarGroups,
    ],
  })],
})
