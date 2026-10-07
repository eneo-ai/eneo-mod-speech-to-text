import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareMarkdown, routeFor } from './content.mjs'

test('generated titles and links preserve GitHub source and nested decision URLs', () => {
  const source = '# Beslut: "Dialoger"\n\n[Drift](../operations.md#miljövariabler) och [index](README.md).\n'
  const generated = prepareMarkdown(source, 'decisions/0004-dialogs.md')
  assert.match(generated, /title: "Beslut: \\"Dialoger\\""/)
  assert.ok(generated.includes('/eneo-mod-speech-to-text/operations/#miljövariabler'))
  assert.ok(generated.includes('/eneo-mod-speech-to-text/decisions/'))
  assert.ok(source.startsWith('# Beslut'))
  assert.equal(routeFor('index.md'), '')
  assert.equal(routeFor('decisions/README.md'), 'decisions')
})

test('external links and same-page anchors remain intact', () => {
  const generated = prepareMarkdown('# Sida\n\n[Extern](https://example.org/page.md) [Rubrik](#rubrik)', 'page.md')
  assert.ok(generated.includes('https://example.org/page.md'))
  assert.ok(generated.includes('](#rubrik)'))
})

test('the homepage keeps its introduction without disabling the documentation navigation', () => {
  const source = '# Tal till text\n\nGör text av ett möte.\n\nDet här är dokumentationen.\n'
  const generated = prepareMarkdown(source, 'index.md')
  assert.doesNotMatch(generated, /template: splash/)
  assert.equal(generated.match(/Gör text av ett möte\./g).length, 1)
  assert.ok(generated.includes('Det här är dokumentationen.'))
  assert.equal(source, '# Tal till text\n\nGör text av ett möte.\n\nDet här är dokumentationen.\n')
})

test('missing titles and links leaving the content root fail the build', () => {
  assert.throws(() => prepareMarkdown('Ingen rubrik', 'page.md'), /missing page heading/)
  assert.throws(() => prepareMarkdown('# Sida\n\n[Fel](../outside.md)', 'page.md'), /link leaves docs/)
})
