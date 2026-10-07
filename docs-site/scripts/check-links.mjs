import { readFileSync, readdirSync } from 'node:fs'
import { parse } from 'parse5'
import { BASE } from './content.mjs'

export function checkLinks(root) {
  const files = readdirSync(root, { recursive: true }).map(String)
  const exists = new Set(files)
  const pages = new Map()
  for (const file of files.filter((file) => file.endsWith('.html'))) {
    const ids = new Set(), links = []
    function visit(node) {
      for (const { name, value } of node.attrs ?? []) {
        if (name === 'id') ids.add(value)
        if (node.tagName === 'a' && name === 'href') links.push(value)
        if (node.tagName === 'link' && name === 'href') links.push(value)
        if (['script', 'img', 'source'].includes(node.tagName) && name === 'src') links.push(value)
      }
      for (const child of node.childNodes ?? []) visit(child)
    }
    visit(parse(readFileSync(new URL(file, root), 'utf8')))
    pages.set(file, { ids, links })
  }
  const failures = []
  for (const [file, { links }] of pages) for (const href of links) {
    const url = new URL(href, `https://docs.invalid${BASE}/${file}`)
    if (url.origin !== 'https://docs.invalid') continue
    const path = decodeURIComponent(url.pathname.replace(`${BASE}/`, ''))
    const target = [path, `${path}index.html`, `${path}/index.html`].find((candidate) => exists.has(candidate))
    if (!target) failures.push(`${file}: missing ${href}`)
    else if (url.hash && pages.has(target) && !pages.get(target).ids.has(decodeURIComponent(url.hash.slice(1)))) failures.push(`${file}: missing heading ${href}`)
  }
  if (failures.length) throw new Error(failures.join('\n'))
}
