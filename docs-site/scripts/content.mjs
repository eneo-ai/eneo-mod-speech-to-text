import { posix } from 'node:path'

export const BASE = '/eneo-mod-speech-to-text'

export function routeFor(file) {
  return file.replace(/\.md$/, '').replace(/(^|\/)README$/, '$1index').replace(/(^|\/)index$/, '$1').replace(/\/$/, '')
}

/** The source remains readable on GitHub; only the build copy gets Starlight metadata and site URLs. */
export function prepareMarkdown(source, file) {
  const heading = source.match(/^# (.+)\r?$/m)
  if (!heading) throw new Error(`${file}: missing page heading`)
  let body = source.replace(heading[0], '').trimStart().replace(/\]\(([^\s)]+)\)/g, (match, href) => {
    if (/^(?:[a-z]+:|#|\/\/)/i.test(href)) return match
    const [path, hash] = href.split('#')
    if (!path.endsWith('.md') && !path.startsWith('images/') && path !== 'api/openapi.json') return match
    const target = posix.normalize(posix.join(posix.dirname(file), path))
    if (target.startsWith('../')) throw new Error(`${file}: link leaves docs: ${href}`)
    return `](${BASE}/${path.endsWith('.md') ? routeFor(target) + '/' : target}${hash ? '#' + hash : ''})`
  })
  // The native hero presents the introduction once; the documentation template keeps the sidebar on the homepage.
  let template = ''
  if (file === 'index.md') {
    const introduction = body.split(/\n\s*\n/, 1)[0]
    body = body.slice(introduction.length).trimStart()
    template = `hero:\n  tagline: ${JSON.stringify(introduction)}\n  actions:\n    - text: Driftsätt modulen\n      link: ${BASE}/operations/\n      icon: right-arrow\n    - text: Lokal utveckling\n      link: ${BASE}/development/\n      variant: secondary\n`
  }
  const apiLink = file === 'api-referens.md' ? `\n\n[Öppna API-anropen](${BASE}/api/)\n` : ''
  return `---\ntitle: ${JSON.stringify(heading[1])}\n${template}---\n\n${body}${apiLink}`
}
