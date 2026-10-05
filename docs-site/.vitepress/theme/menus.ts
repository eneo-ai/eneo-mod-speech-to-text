// Escape closes the menus that open over the page on a narrow screen, and focus goes back to the button that opened them.
export function closeMenusOnEscape() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    const opener =
      (document.querySelector('.VPSidebar.open') && document.querySelector<HTMLButtonElement>('.VPLocalNav button.menu')) ||
      document.querySelector<HTMLButtonElement>('.VPNavBarHamburger.active')
    if (!opener) return
    opener.click()
    opener.focus()
  })
}
