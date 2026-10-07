import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareMarkdown } from './content.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
export const docs = join(root, '../docs')
const target = join(root, 'src/content/docs')
export function prepareContent() {
  mkdirSync(target, { recursive: true })
  const expected = new Set()
  for (const file of readdirSync(docs, { recursive: true })) {
    if (!file.endsWith('.md') || file.startsWith('plans/')) continue
    const destination = join(target, file.replace(/(^|\/)README\.md$/, '$1index.md'))
    expected.add(destination)
    mkdirSync(dirname(destination), { recursive: true })
    const content = prepareMarkdown(readFileSync(join(docs, file), 'utf8'), file)
    let previous
    try { previous = readFileSync(destination, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (previous !== content) writeFileSync(destination, content)
  }
  for (const file of readdirSync(target, { recursive: true }).filter((file) => file.endsWith('.md'))) {
    const destination = join(target, file)
    if (!expected.has(destination)) rmSync(destination)
  }
  mkdirSync(join(root, 'public'), { recursive: true })
  cpSync(join(root, 'mark.svg'), join(root, 'public/favicon.svg'))
  cpSync(join(docs, 'images'), join(root, 'public/images'), { recursive: true })
  cpSync(join(docs, 'api'), join(root, 'public/api'), { recursive: true })
}

export function sourceContent() {
  return { name: 'docs-source-content', hooks: { 'astro:server:setup': ({ server }) => {
    server.watcher.add(docs)
    server.watcher.on('all', (event, file) => {
      if (file.startsWith(docs + '/') && ['add', 'change', 'unlink'].includes(event)) prepareContent()
    })
  } } }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) prepareContent()
