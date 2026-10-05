<script setup lang="ts">
// Mounts Scalar on this page only. It is fetched when the page opens, and reads docs/api/openapi.json from the site's own files.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useData } from 'vitepress'
import spec from '../../../docs/api/openapi.json?url'
import { translations } from './scalar-sv'

const host = ref<HTMLElement>()
const { isDark } = useData()
let reference: { destroy: () => void } | undefined

async function show() {
  const { createApiReference } = await import('@scalar/api-reference')
  await import('@scalar/api-reference/style.css')
  reference?.destroy()
  reference = createApiReference(host.value!, {
    url: spec,
    withDefaultFonts: false,
    hideTestRequestButton: true,
    hideClientButton: true,
    defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
    hideDarkModeToggle: true,
    showDeveloperTools: 'never',
    telemetry: false,
    agent: { disabled: true },
    mcp: { disabled: true },
    forceDarkModeState: isDark.value ? 'dark' : 'light',
    localization: { locale: 'sv', translations },
  })
}

onMounted(show)
watch(isDark, show)
onBeforeUnmount(() => reference?.destroy())
</script>

<template>
  <div ref="host" class="api-reference"></div>
</template>
