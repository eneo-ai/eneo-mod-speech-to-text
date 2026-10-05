// The browser check of the built site (npm run build first): the start page, the API page and every page with a diagram.
// Starts its own preview server on DOCS_PORT (default 4173) and stops it. Exits 1 on any finding.
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const PORT = Number(process.env.DOCS_PORT ?? 4173)
const BASE = `http://localhost:${PORT}/eneo-mod-speech-to-text`
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

const docs = new URL('../docs/', import.meta.url)
const withDiagrams = readdirSync(docs, { recursive: true })
  .filter((file) => String(file).endsWith('.md') && !String(file).startsWith('plans'))
  .map((file) => [String(file), (readFileSync(new URL(String(file), docs), 'utf8').match(/^```mermaid$/gm) ?? []).length])
  .filter(([, count]) => count > 0)
const route = (file) => '/' + file.replace(/\.md$/, '').replace(/(^|\/)README$/, '$1')

const findings = []
const note = (page, what) => findings.push(`${page}: ${what}`)

{ // Every link to a heading on the site leads to an id that exists on the page it names.
  const dist = new URL('.vitepress/dist/', import.meta.url)
  const pages = new Map(readdirSync(dist, { recursive: true }).filter((file) => String(file).endsWith('.html')).map((file) => [String(file), readFileSync(new URL(String(file), dist), 'utf8')]))
  const ids = new Map([...pages].map(([file, html]) => [file, new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))]))
  for (const [file, html] of pages) {
    for (const [, href] of html.matchAll(/<a [^>]*href="([^"]*#[^"]*)"/g)) {
      const [path, fragment] = href.split('#')
      if (/^[a-z]+:/.test(path)) continue
      const target = path ? new URL(path, `http://x/eneo-mod-speech-to-text/${file}`).pathname.replace('/eneo-mod-speech-to-text/', '') : file
      const page = [target, `${target}.html`, `${target}index.html`, `${target}/index.html`].find((candidate) => ids.has(candidate))
      if (page && !ids.get(page).has(decodeURIComponent(fragment))) note(file, `a link to ${href} has no heading with that id`)
    }
  }
}

const server = spawn('node', ['node_modules/vitepress/bin/vitepress.js', 'preview', '--port', String(PORT)], { stdio: 'ignore' })
const stop = () => server.kill()
process.on('exit', stop)
for (let tries = 0; ; tries++) {
  try {
    if ((await fetch(`${BASE}/`)).ok) break
  } catch {}
  if (tries > 60) throw new Error('the preview server did not start')
  await new Promise((resolve) => setTimeout(resolve, 500))
}

const browser = await chromium.launch()
async function open(path, { width = 1440, scheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, locale: 'sv-SE', reducedMotion: 'reduce' })
  const page = await context.newPage()
  const label = `${path} (${width}, ${scheme})`
  page.on('console', (message) => message.type() === 'error' && note(label, `console error: ${message.text()}`))
  page.on('pageerror', (error) => note(label, `page error: ${error.message}`))
  page.on('request', (request) => new URL(request.url()).hostname !== 'localhost' && note(label, `external request: ${request.url()}`))
  page.on('request', (request) => /AgentScalarDrawer/.test(request.url()) && note(label, 'the API page loaded Scalar\'s agent'))
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  return { page, context, label }
}

for (const path of ['/', '/api-referens']) {
  for (const [width, scheme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    const { page, context, label } = await open(path, { width, scheme })
    if (path === '/api-referens') await page.locator('.scalar-app').first().waitFor()
    for (const violation of (await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations) {
      note(label, `axe ${violation.id}: ${violation.nodes.length} node(s), e.g. ${violation.nodes[0].target.join(' ')}`)
    }
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) note(label, 'the page scrolls sideways')
    // The default theme's own screen-reader text is English; it must be Swedish after the page has been hydrated.
    const english = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label], .visually-hidden')]
        .map((node) => node.getAttribute('aria-label') ?? node.textContent.trim())
        .filter((text) => /^(Main Navigation|Sidebar Navigation|Pager|mobile navigation|extra navigation|toggle section)$|^Permalink to/.test(text)),
    )
    if (english.length) note(label, `English screen-reader text: ${english.join(', ')}`)
    await context.close()
  }
}

{ // Keyboard: the skip link is first and lands in the content; the search opens and closes with the keyboard.
  const { page, context, label } = await open('/')
  await page.keyboard.press('Tab')
  if (!(await page.evaluate(() => document.activeElement?.classList.contains('VPSkipLink')))) note(label, 'the skip link is not the first stop')
  await page.keyboard.press('ControlOrMeta+k')
  const box = page.locator('.VPLocalSearchBox')
  await box.waitFor({ timeout: 5000 }).catch(() => note(label, 'the search does not open with Ctrl+K'))
  await page.keyboard.press('Escape')
  await box.waitFor({ state: 'detached', timeout: 5000 }).catch(() => note(label, 'the search does not close with Escape'))
  await context.close()
}

{ // Mobile: the menu opens and its links work.
  const { page, context, label } = await open('/', { width: 390 })
  await page.getByRole('button', { name: 'Navigering' }).click()
  await page.locator('.VPNavScreen').getByRole('link', { name: 'API-referens' }).click()
  await page.waitForURL(/api-referens/)
  await page.waitForFunction(() => document.title === 'API-referens · Tal till text', null, { timeout: 5000 }).catch(() => note(label, `the title did not change after navigation`))
  await context.close()
}

for (const [file, count] of withDiagrams) { // Every diagram is drawn, in both modes.
  for (const scheme of ['light', 'dark']) {
    const { page, context, label } = await open(route(file), { scheme })
    await page.waitForFunction((n) => document.querySelectorAll('pre.mermaid[data-drawn]').length >= n, count, { timeout: 30000 }).catch(() => {})
    const failed = await page.locator('pre.mermaid[data-drawn="failed"]').count()
    const drawn = await page.locator(`pre.mermaid[data-drawn="${scheme}"] svg`).count()
    if (failed || drawn !== count) note(label, `${drawn} of ${count} diagrams drawn, ${failed} failed`)
    // Natural size: no diagram is drawn narrower than its viewBox, and none makes the page scroll sideways.
    const shrunk = await page.evaluate(() =>
      [...document.querySelectorAll('pre.mermaid svg')].filter((svg) => svg.getBoundingClientRect().width < svg.viewBox.baseVal.width - 1).length,
    )
    if (shrunk) note(label, `${shrunk} diagram(s) are scaled down`)
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) note(label, 'the page scrolls sideways')
    await context.close()
  }
}

await browser.close()
stop()
if (findings.length) {
  console.error(findings.map((finding) => `- ${finding}`).join('\n'))
  process.exit(1)
}
console.log(`docs site: ok (heading links, ${2 * 4} start and API renderings, keyboard, menu, ${withDiagrams.reduce((n, [, c]) => n + c, 0)} diagrams on ${withDiagrams.length} pages)`)
