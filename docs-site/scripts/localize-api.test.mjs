import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localizeApiHtml } from './localize-api.mjs'

test('API labels are Swedish while schema keys, examples and authored descriptions remain intact', () => {
  const html = '<h2>Responses</h2><div class="sl-openapi-key-name"><strong>required</strong><div class="sl-openapi-key-required">required</div></div><pre><code>Responses</code></pre><div class="sl-openapi-markdown"><p>Responses</p></div><button aria-label="Toggle operation URLs"></button>'
  const result = localizeApiHtml(html, true)
  assert.ok(result.includes('<h2>Svar</h2>'))
  assert.ok(result.includes('<strong>required</strong>'))
  assert.ok(result.includes('sl-openapi-key-required">obligatoriskt'))
  assert.ok(result.includes('<code>Responses</code>'))
  assert.ok(result.includes('<p>Responses</p>'))
  assert.ok(result.includes('aria-label="Visa eller dölj anropets adresser"'))
})

test('ordinary document prose is not localized by the API adapter', () => {
  const result = localizeApiHtml('<main><p>Responses</p></main><nav class="sidebar"><a>Overview</a></nav>', false)
  assert.ok(result.includes('<p>Responses</p>'))
  assert.ok(result.includes('<a>Översikt</a>'))
})

test('plugin labels with a trailing colon keep their punctuation in Swedish', () => {
  const result = localizeApiHtml('<span>Any of:</span><span>Security scheme type:</span><span>Cookie parameter name:</span><code>Any of:</code>', true)
  assert.ok(result.includes('<span>Något av:</span>'))
  assert.ok(result.includes('<span>Typ av inloggning:</span>'))
  assert.ok(result.includes('<span>Namn på kakparametern:</span>'))
  assert.ok(result.includes('<code>Any of:</code>'))
})
