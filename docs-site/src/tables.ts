/** Native tables scroll horizontally; only overflowing tables need a keyboard stop. */
export function makeTablesReachable() {
  const headings = [...document.querySelectorAll<HTMLElement>('main :is(h1, h2, h3, h4, h5, h6)')]
  const update = (table: HTMLTableElement) => {
    if (table.scrollWidth > table.clientWidth + 1) table.tabIndex = 0
    else table.removeAttribute('tabindex')
  }
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) update(entry.target as HTMLTableElement)
  })
  for (const table of document.querySelectorAll<HTMLTableElement>('.sl-markdown-content table')) {
    if (!table.caption?.textContent?.trim() && !table.hasAttribute('aria-label') && !table.hasAttribute('aria-labelledby')) {
      const heading = headings.findLast((heading) => heading.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING)
      if (heading?.id) table.setAttribute('aria-labelledby', heading.id)
      else table.setAttribute('aria-label', heading?.textContent?.trim() || 'Tabell')
    }
    update(table)
    observer.observe(table)
  }
}
