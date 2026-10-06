// Keep the current page visible without moving keyboard focus or scrolling the document.
export function revealCurrentPage() {
  const sidebar = document.getElementById('starlight__sidebar')
  const active = sidebar?.querySelector<HTMLAnchorElement>('a[aria-current="page"]')
  if (!sidebar || !active || !sidebar.getClientRects().length) return
  for (let parent = active.parentElement; parent && parent !== sidebar; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true
  }
  const bounds = sidebar.getBoundingClientRect()
  const row = active.getBoundingClientRect()
  if (row.top < bounds.top || row.bottom > bounds.bottom) {
    sidebar.scrollTop += row.top - bounds.top - (sidebar.clientHeight - row.height) / 2
  }
}

export function followCurrentPage() {
  requestAnimationFrame(revealCurrentPage)
  document.getElementById('starlight__sidebar')?.addEventListener('toggle', (event) => {
    if ((event as ToggleEvent).newState === 'open') requestAnimationFrame(revealCurrentPage)
  })
}
