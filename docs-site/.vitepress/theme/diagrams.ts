// Renders the pages' Mermaid diagrams in the browser. mermaid is fetched on the first page that has one, and each
// diagram type is fetched when a diagram of it is drawn: the other pages never load it.
const SELECTOR = 'pre.mermaid'
let drawing = Promise.resolve()

async function draw() {
  const nodes = [...document.querySelectorAll<HTMLElement>(SELECTOR)].filter((node) => !node.dataset.drawn)
  if (!nodes.length) return
  const { default: mermaid } = await import('mermaid')
  const dark = document.documentElement.classList.contains('dark')
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'neutral',
    fontFamily: getComputedStyle(document.body).fontFamily,
  })
  for (const node of nodes) {
    node.dataset.source ??= node.textContent ?? ''
    const id = `diagram-${Math.random().toString(36).slice(2)}`
    try {
      const { svg } = await mermaid.render(id, node.dataset.source)
      node.innerHTML = svg
      node.dataset.drawn = dark ? 'dark' : 'light'
    } catch (error) {
      document.getElementById(`d${id}`)?.remove()
      node.dataset.drawn = 'failed'
      node.title = String(error)
    }
  }
}

/** Draws what is on the page now; calls queue, so a page change during a draw is not lost. */
export function drawDiagrams() {
  drawing = drawing.then(draw)
  return drawing
}

/** A diagram is drawn for one colour mode; it is drawn again when the mode changes. */
export function redrawOnColourMode() {
  new MutationObserver(() => {
    const mode = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    for (const node of document.querySelectorAll<HTMLElement>(`${SELECTOR}[data-drawn]`)) {
      if (node.dataset.drawn !== 'failed' && node.dataset.drawn !== mode) delete node.dataset.drawn
    }
    drawDiagrams()
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
}
