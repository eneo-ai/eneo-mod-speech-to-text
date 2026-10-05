<script setup lang="ts">
// Mounts Scalar on this page only. It is fetched when the page opens, and reads docs/api/openapi.json from the site's own files.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useData } from 'vitepress'
import specUrl from '../../../docs/api/openapi.json?url'
import { translations } from './scalar-sv'

const host = ref<HTMLElement>()
const { isDark } = useData()
let reference: { destroy: () => void } | undefined

/** The spec, with each tag's external documentation as a link in its description: Scalar does not draw externalDocs. */
async function spec() {
  const document = await (await fetch(specUrl)).json()
  for (const tag of document.tags ?? []) {
    const docs = tag.externalDocs
    if (docs?.url) tag.description = `${tag.description ?? ''}\n\n[${docs.description ?? docs.url}](${docs.url})`.trim()
  }
  return document
}

async function show() {
  const [{ createApiReference }, content] = await Promise.all([import('@scalar/api-reference'), spec(), import('@scalar/api-reference/style.css')])
  reference?.destroy()
  reference = createApiReference(host.value!, {
    content,
    withDefaultFonts: false,
    hideTestRequestButton: true,
    // The page is called by the module's own page with its session cookie: samples in other languages would mislead.
    hiddenClients: true,
    hideClientButton: true,
    hideDarkModeToggle: true,
    showDeveloperTools: 'never',
    telemetry: false,
    agent: { disabled: true },
    mcp: { disabled: true },
    // Every tag open, so that the browser's find-in-page sees every operation.
    defaultOpenAllTags: true,
    // The site's own search owns Ctrl+K and Cmd+K.
    searchHotKey: 'j',
    forceDarkModeState: isDark.value ? 'dark' : 'light',
    localization: { locale: 'sv', translations },
  })
}

/** Scalar's section ids carry the document's prefix ("api-1/tag/…"), its links do not, and VitePress takes over every
 *  link to a hash on the page and looks for the unprefixed id: so the click is followed here. */
function follow(event: MouseEvent) {
  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]')
  const root = host.value
  if (!link || !root) return
  const hash = decodeURIComponent(link.getAttribute('href')!.slice(1))
  let tries = 0
  const go = () => {
    const target = document.getElementById(hash) ?? [...root.querySelectorAll<HTMLElement>('[id]')].find((element) => element.id.endsWith(`/${hash}`))
    if (target) {
      target.scrollIntoView({ block: 'start' })
      // On a narrow screen Scalar's menu is a drawer that covers the page: it closes when a link has been followed.
      ;[...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === translations.navigation.closeMenu)?.click()
    } else if (tries++ < 20) setTimeout(go, 50)
  }
  setTimeout(go, 0)
}

onMounted(() => {
  host.value?.addEventListener('click', follow)
  void show()
})
watch(isDark, show)
onBeforeUnmount(() => {
  host.value?.removeEventListener('click', follow)
  reference?.destroy()
})
</script>

<template>
  <div ref="host" class="api-reference"></div>
</template>
