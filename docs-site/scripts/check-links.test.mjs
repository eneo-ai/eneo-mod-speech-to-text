import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkLinks } from './check-links.mjs'

test('missing built stylesheets fail rather than leaving code blocks unstyled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-links-'))
  try {
    writeFileSync(join(dir, 'index.html'), '<link rel="stylesheet" href="/eneo-mod-speech-to-text/missing.css">')
    assert.throws(() => checkLinks(pathToFileURL(dir + '/')), /missing.*missing\.css/)
    writeFileSync(join(dir, 'missing.css'), 'pre { overflow: auto }')
    assert.doesNotThrow(() => checkLinks(pathToFileURL(dir + '/')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('local heading targets are validated with encoded Swedish characters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-links-'))
  try {
    writeFileSync(join(dir, 'index.html'), '<a href="#milj%C3%B6">Drift</a><h2 id="miljö">Drift</h2>')
    assert.doesNotThrow(() => checkLinks(pathToFileURL(dir + '/')))
    writeFileSync(join(dir, 'index.html'), '<a href="#milj%C3%B6">Drift</a>')
    assert.throws(() => checkLinks(pathToFileURL(dir + '/')), /missing heading/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
