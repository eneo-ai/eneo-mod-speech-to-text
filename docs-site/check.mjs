// Browser proof for the built site, including generated OpenAPI pages and the local search index.
import { preview } from 'astro'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { BASE, routeFor } from './scripts/content.mjs'
import { checkLinks } from './scripts/check-links.mjs'

checkLinks(new URL('./dist/', import.meta.url))
const PORT = Number(process.env.DOCS_PORT ?? 4173)
const ORIGIN = `http://localhost:${PORT}`
const URL_ROOT = `${ORIGIN}${BASE}`
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const findings = []
const note = (page, what) => findings.push(`${page}: ${what}`)
const audit = async (page, label) => {
  for (const violation of (await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations) note(label, `axe ${violation.id}: ${violation.nodes.length} node(s), ${violation.nodes[0].target.join(' ')}`)
}
const server = await preview({ server: { host: '127.0.0.1', port: PORT } })
const stop = () => server.stop()
const browser = await chromium.launch()
async function open(path, { width = 1440, scheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, locale: 'sv-SE', reducedMotion: 'reduce' })
  const page = await context.newPage()
  const label = `${path} (${width}, ${scheme})`
  page.on('console', (message) => message.type() === 'error' && note(label, `console: ${message.text()}`))
  page.on('pageerror', (error) => note(label, `page error: ${error.message}`))
  page.on('request', (request) => new URL(request.url()).origin !== ORIGIN && note(label, `external request: ${request.url()}`))
  const response = await page.goto(`${URL_ROOT}${path}`, { waitUntil: 'networkidle' })
  if (!response?.ok()) note(label, `HTTP ${response?.status()}`)
  return { page, context, label }
}
const pages = readdirSync(new URL('./dist/', import.meta.url), { recursive: true }).map(String)
  .filter((file) => file.endsWith('.html') && file !== '404.html')
  .map((file) => '/' + file.replace(/index\.html$/, '')).sort()
let renderings = 0
let diagramPages = 0
try {
for (const path of pages) for (const [width, scheme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
  const { page, context, label } = await open(path, { width, scheme })
  renderings++
  await audit(page, label)
  if (await page.getByRole('heading', { level: 1 }).count() !== 1) note(label, 'the page does not have exactly one main heading')
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) note(label, 'the page scrolls sideways')
  if (!(await page.locator('html').getAttribute('lang'))?.startsWith('sv')) note(label, 'the page language is not Swedish')
  if (path.startsWith('/api/')) {
    const headings = await page.getByRole('heading').allTextContents()
    if (headings.some((text) => ['Overview', 'Parameters', 'Request Body', 'Responses', 'Examples', 'Authentication'].includes(text.trim()))) note(label, 'an API heading is still English')
  }
  if (process.env.DOCS_SHOTS_DIR) {
    const folder = join(process.env.DOCS_SHOTS_DIR, path === '/' ? 'index' : path.replace(/^\/|\/$/g, '').replaceAll('/', '-'))
    mkdirSync(folder, { recursive: true })
    await page.screenshot({ path: join(folder, `${width}x900-${scheme}.first.png`) })
  }
  for (const table of await page.locator('.sl-markdown-content table').all()) {
    if (width === 1440) {
      const broken = await table.locator('td code').evaluateAll((codes) => codes
        .filter((code) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(code.textContent ?? '') && code.getClientRects().length > 1)
        .map((code) => code.textContent))
      if (broken.length) note(label, `desktop table identifiers break across lines: ${broken.join(', ')}`)
    }
    const state = await table.evaluate((table) => ({
      overflowing: table.scrollWidth > table.clientWidth + 1,
      tabbable: table.getAttribute('tabindex') === '0',
      named: !!(table.getAttribute('aria-label')?.trim() || table.querySelector('caption')?.textContent?.trim()
        || table.getAttribute('aria-labelledby')?.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())),
    }))
    if (!state.overflowing) {
      if (state.tabbable) note(label, 'a table that fits adds an unnecessary Tab stop')
      continue
    }
    if (!state.tabbable || !state.named) note(label, 'an overflowing table has no named keyboard stop')
    await table.evaluate((table) => { table.scrollLeft = 0 })
    await table.press('ArrowRight')
    await page.waitForTimeout(200)
    if (!await table.evaluate((table) => table === document.activeElement && table.scrollLeft > 0)) note(label, 'the keyboard cannot scroll an overflowing table')
  }
  await context.close()
  if (scheme === 'dark' && width === 390) console.log(`checked ${path}`)
}
for (const width of [320, 1440]) {
  const { page, context, label } = await open('/', { width })
  if (width < 800) await page.locator('.sl-menu-button').click()
  const sidebar = page.locator('#starlight__sidebar')
  if (!await sidebar.isVisible()) note(label, 'the homepage has no documentation navigation')
  for (const path of ['quality-gates', 'auth-and-session', 'eneo-integration', 'backend', 'frontend', 'recording', 'decisions']) {
    if (await sidebar.locator(`a[href="${BASE}/${path}/"]`).count() !== 1) note(label, `the homepage navigation lacks ${path}`)
  }
  await context.close()
}
{
  const { page, context, label } = await open('/')
  await page.keyboard.press('Tab')
  if (!await page.getByRole('link', { name: 'Hoppa till innehåll', exact: true }).evaluate((link) => link === document.activeElement)) note(label, 'the skip link is not first')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  if (!await page.evaluate(() => !!document.activeElement?.closest('main'))) note(label, 'the skip link does not bypass navigation')
  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.locator('site-search dialog')
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('textbox').fill('miljövariabler')
  const result = dialog.locator('a[href*="/operations/"]').first()
  await result.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  if (await dialog.isVisible()) note(label, 'Escape does not close search')
  await page.keyboard.press('ControlOrMeta+k')
  await dialog.getByRole('textbox').fill('miljövariabler')
  await result.click()
  await page.waitForURL(/\/operations\//)
  await context.close()
}
for (const width of [320, 390, 1440]) for (const scheme of ['light', 'dark']) {
  const { page, context, label } = await open('/operations/', { width, scheme })
  await page.locator('site-search button[data-open-modal]').focus()
  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.locator('site-search dialog')
  await dialog.getByRole('textbox').fill('miljövariabler')
  await dialog.locator('a[href*="/operations/"]').first().waitFor({ state: 'visible' })
  if (!await dialog.getByRole('textbox').evaluate((input) => {
    const style = getComputedStyle(input)
    return input === document.activeElement && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
  })) note(label, 'the search field has no visible keyboard focus outline')
  await audit(page, label + ', filled search')
  const small = await dialog.locator('button').evaluateAll((nodes) => nodes.filter((node) => {
    const box = node.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && Math.min(box.width, box.height) < 44
  }).length)
  if (small) note(label, `${small} search controls under 44 px`)
  await dialog.getByRole('button', { name: 'Rensa sökningen' }).click()
  if (await dialog.getByRole('textbox').inputValue() !== '') note(label, 'clear search does not empty the field')
  if (width < 800) await dialog.getByRole('button', { name: 'Avbryt', exact: true }).click()
  else await page.keyboard.press('Escape')
  if (await dialog.isVisible()) note(label, 'search does not close')
  if (!await page.locator('site-search button[data-open-modal]').evaluate((button) => button === document.activeElement)) note(label, 'closing search does not restore focus')
  await context.close()
}
for (const width of [320, 390]) {
  const { page, context, label } = await open('/operations/', { width })
  if (await page.locator('#starlight__sidebar').isVisible()) note(label, 'the closed sidebar is visible')
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) note(label, 'tables overflow the page')
  const small = async (selector, what) => {
    const count = await page.locator(selector).evaluateAll((nodes) => nodes.filter((node) => {
      const box = node.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && Math.min(box.width, box.height) < 44
    }).length)
    if (count) note(label, `${count} ${what} under 44 px`)
  }
  await small('.sl-menu-button, site-search button[data-open-modal], .site-title, .expressive-code button', 'controls')
  const opener = page.locator('.sl-menu-button')
  await opener.click()
  await page.locator('#starlight__sidebar').waitFor({ state: 'visible' })
  await small('#starlight__sidebar a, #starlight__sidebar summary', 'sidebar targets')
  await page.keyboard.press('Escape')
  if (await page.locator('#starlight__sidebar').isVisible()) note(label, 'Escape does not close sidebar')
  if (!await opener.evaluate((button) => button === document.activeElement)) note(label, 'Escape does not restore menu focus')
  await opener.click()
  await page.locator('#starlight__sidebar').getByRole('link', { name: 'API-referens', exact: true }).click()
  await page.waitForURL(/\/api-referens\//)
  await page.getByRole('link', { name: 'Öppna API-anropen' }).click()
  await page.waitForURL(/\/api\/$/)
  await context.close()
}
for (const width of [320, 390, 1440]) {
  const { page, context, label } = await open('/decisions/0008-static-ui-served-by-the-bff/', { width })
  if (width < 800) await page.locator('.sl-menu-button').click()
  await page.waitForFunction(() => {
    const sidebar = document.getElementById('starlight__sidebar')
    const active = sidebar?.querySelector('a[aria-current="page"]')
    if (!sidebar || !active) return false
    const row = active.getBoundingClientRect(), bounds = sidebar.getBoundingClientRect()
    return row.top >= bounds.top && row.bottom <= bounds.bottom
  })
  if (await page.evaluate(() => scrollY !== 0)) note(label, 'revealing the current page moved the document')
  if (width < 800 && !await page.locator('.sl-menu-button').evaluate((button) => button === document.activeElement)) note(label, 'revealing the current page moved keyboard focus')
  await context.close()
}
{
  const { page, context } = await open('/architecture/')
  const theme = page.locator('header starlight-theme-select')
  const opener = theme.getByRole('button', { name: /^Välj tema:/ })
  await opener.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  if (!await theme.getByRole('menuitemradio', { name: 'Mörkt', exact: true }).evaluate((button) => button === document.activeElement)) note('/architecture/', 'theme menu keyboard navigation failed')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  if (!await opener.evaluate((button) => button === document.activeElement)) note('/architecture/', 'choosing a theme does not restore focus')
  await page.waitForFunction(() => document.querySelector('pre.mermaid[data-drawn="dark"] svg'))
  await opener.click()
  await theme.getByRole('menuitemradio', { name: 'Ljust', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('pre.mermaid[data-drawn="light"] svg'))
  await opener.click()
  await page.keyboard.press('Escape')
  if (await theme.getByRole('menu').isVisible()) note('/architecture/', 'Escape does not close the theme menu')
  if (!await opener.evaluate((button) => button === document.activeElement)) note('/architecture/', 'Escape does not restore theme focus')
  await context.close()
}
const docsRoot = new URL('../docs/', import.meta.url)
const diagrams = readdirSync(docsRoot, { recursive: true }).map(String)
  .filter((file) => file.endsWith('.md') && !file.startsWith('plans/'))
  .map((file) => [file, (readFileSync(new URL(file, docsRoot), 'utf8').match(/^```mermaid$/gm) ?? []).length])
  .filter(([, count]) => count)
diagramPages = diagrams.length
for (const [file, count] of diagrams) for (const scheme of ['light', 'dark']) {
  const { page, context, label } = await open('/' + routeFor(file) + '/', { scheme })
  await page.waitForFunction((n) => document.querySelectorAll('pre.mermaid[data-drawn]').length >= n, count, { timeout: 30000 }).catch(() => {})
  if (await page.locator(`pre.mermaid[data-drawn="${scheme}"] svg`).count() !== count) note(label, 'a diagram did not render')
  const invalid = await page.locator('pre.mermaid').evaluateAll((nodes) => nodes.filter((node) => {
    const svg = node.querySelector('svg')
    return !svg || svg.getBoundingClientRect().width < svg.viewBox.baseVal.width - 1 || !node.getAttribute('aria-label') || node.getAttribute('aria-label') === 'Diagram'
  }).length)
  if (invalid) note(label, `${invalid} diagram(s) shrunk or unnamed`)
  const overflowing = await page.locator('pre.mermaid').evaluateAll((nodes) => nodes
    .filter((node) => node.scrollWidth > node.clientWidth + 1)
    .map((node) => `${node.scrollWidth} px in a ${node.clientWidth} px column`))
  if (overflowing.length) note(label, `a diagram does not fit the desktop reading column: ${overflowing.join('; ')}`)
  await context.close()
}
} finally {
  await browser.close()
  await stop()
  console.log(`completed ${renderings} page renderings`)
  if (findings.length) console.error(findings.map((finding) => `- ${finding}`).join('\n'))
}
if (findings.length) process.exit(1)
console.log(`docs site: ok (links, axe on ${pages.length} pages in ${renderings} renderings, indexed search, keyboard, themes, homepage navigation, narrow menus, named keyboard scrolling for overflowing tables, touch targets and ${diagramPages} diagram pages)`)
