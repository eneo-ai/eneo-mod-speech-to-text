// The default theme's screen-reader text that no setting reaches. It is replaced in the built pages (so it is Swedish
// without JavaScript) and in the browser (so it stays Swedish when the theme draws a page again).
const TEXTS: Record<string, string> = {
  'Main Navigation': 'Huvudnavigering',
  'Sidebar Navigation': 'Sidonavigering',
  Pager: 'Föregående och nästa sida',
  'mobile navigation': 'Navigering',
  'extra navigation': 'Fler val',
  'toggle section': 'Visa eller dölj avsnittet',
}
const PERMALINK = { english: 'Permalink to ', swedish: 'Länk till ' }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Built pages: the same replacements on the HTML text. */
export function localizeHtml(html: string) {
  for (const [english, swedish] of Object.entries(TEXTS)) {
    html = html
      .replace(new RegExp(`aria-label="${escape(english)}"`, 'g'), `aria-label="${swedish}"`)
      .replace(new RegExp(`(<span[^>]*class="visually-hidden"[^>]*>\\s*)${escape(english)}(\\s*</span>)`, 'g'), `$1${swedish}$2`)
  }
  return html.replaceAll(`aria-label="${PERMALINK.english}`, `aria-label="${PERMALINK.swedish}`)
}

function localizeDom(root: ParentNode) {
  for (const node of root.querySelectorAll<HTMLElement>('[aria-label], .visually-hidden')) {
    const label = node.getAttribute('aria-label')
    if (label && TEXTS[label]) node.setAttribute('aria-label', TEXTS[label])
    else if (label?.startsWith(PERMALINK.english)) node.setAttribute('aria-label', PERMALINK.swedish + label.slice(PERMALINK.english.length))
    const text = node.classList.contains('visually-hidden') ? node.textContent?.trim() : undefined
    if (text && TEXTS[text]) node.textContent = TEXTS[text]
  }
}

export function localizeLabels() {
  localizeDom(document)
  new MutationObserver(() => localizeDom(document)).observe(document.body, { childList: true, subtree: true })
}
