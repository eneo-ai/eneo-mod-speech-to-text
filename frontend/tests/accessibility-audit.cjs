/** Run against synthetic dev fixtures only. See docs/accessibility-review-2026-09-15.md. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;
const output = process.env.A11Y_REPORT || '/tmp/lyssna-accessibility-report.json';
const results = [];
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const colorScheme of ['light', 'dark']) {
      for (const width of [1280, 320]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, reducedMotion: 'reduce' });
        const page = await context.newPage();
        await page.goto('http://localhost:3002/dev/speaker-review');
        const fixture = page.getByRole('combobox', { name: 'Testfall', exact: true });
        async function scan(state) {
          const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
          const overflow = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
          const entry = { colorScheme, width, state, overflow, violations: result.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })), incomplete: result.incomplete.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })) };
          results.push(entry);
          console.log(`${colorScheme} ${width} ${state}: ${entry.violations.length} violations; width ${overflow.content}/${overflow.width}`);
        }
        await fixture.selectOption('bulk');
        await scan('audio-unavailable');
        await page.getByRole('checkbox', { name: 'Tillgängligt testljud' }).check();
        await page.getByRole('button', { name: 'Nästa passage som behöver talarbeslut' }).click();
        await scan('selected-passage');
        await page.getByRole('button', { name: 'Detaljer', exact: true }).click();
        await scan('details');
        await page.getByRole('button', { name: 'Rätta text', exact: true }).click();
        await scan('text-correction');
        await page.getByRole('button', { name: 'Avbryt', exact: true }).click();
        await page.getByRole('button', { name: /^Bekräfta alla förslag/ }).click();
        assert.equal(await page.locator('[data-undo]').evaluate(el => el === document.activeElement), true, 'bulk acceptance restores focus to Undo');
        await scan('confirmed');
        await page.getByRole('button', { name: 'Ångra', exact: true }).click();
        const body = page.getByRole('textbox', { name: 'Transkript, markera ord för att redigera', exact: true });
        await body.focus();
        // A selected passage must not create a Tab cycle back through the toolbar.
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[aria-label="Transkriptverktyg"]')), false, 'Tab follows document order');
        await body.focus();
        await page.keyboard.press('Alt+t');
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[aria-label="Transkriptverktyg"]')), true, 'Alt+T reaches tools');
        await page.getByRole('checkbox', { name: 'Skrivskyddat', exact: true }).check();
        await scan('read-only');
        await page.getByRole('checkbox', { name: 'Skrivskyddat', exact: true }).uncheck();
        await fixture.selectOption('accessibility');
        await page.getByText('Talare', { exact: true }).click();
        const names = page.getByRole('combobox', { name: 'Namn för Talare 1', exact: true });
        await names.focus();
        await page.keyboard.press('ArrowDown');
        const activeId = await names.getAttribute('aria-activedescendant');
        assert.ok(activeId && !/\s/.test(activeId));
        assert.equal(await page.locator(`[id="${activeId}"]`).count(), 1);
        await scan('speaker-names-open');
        await page.keyboard.press('Escape');
        await scan('six-speaker-colors');
        await page.addStyleTag({ content: '.transcript-player *, .speaker-mapping-editor * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } .transcript-editor-text p { margin-bottom: 2em !important; }' });
        await scan('text-spacing');
        await page.locator('[data-text-span]').last().focus();
        await page.waitForFunction(() => {
          const target = document.activeElement, rect = target.getBoundingClientRect();
          const tools = document.querySelector('.transcript-toolbar');
          const toolbarBottom = getComputedStyle(tools).position === 'sticky' ? tools.getBoundingClientRect().bottom : 0;
          return Math.min(rect.bottom, innerHeight) > Math.max(rect.top, toolbarBottom, 0);
        });
        await page.screenshot({ path: `/tmp/lyssna-a11y-${colorScheme}-${width}.png`, fullPage: true });
        await fixture.selectOption('clear');
        await page.emulateMedia({ forcedColors: 'active' });
        await scan('forced-colors');
        const activeWord = page.locator('.transcript-editor-text [aria-current="true"]').first();
        assert.equal(await activeWord.evaluate(el => getComputedStyle(el).forcedColorAdjust), 'none');
        await context.close();
      }
    }
  } finally {
    fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
    await browser.close();
  }
  assert.equal(results.reduce((n, r) => n + r.violations.length, 0), 0, `See ${output}`);
  assert.ok(results.every(r => r.overflow.content <= r.overflow.width + 1), `Horizontal overflow; see ${output}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
