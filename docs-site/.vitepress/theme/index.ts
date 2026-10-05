import DefaultTheme from 'vitepress/theme-without-fonts'
import { defineAsyncComponent, nextTick, onMounted, watch } from 'vue'
import { useRoute } from 'vitepress'
import { drawDiagrams, redrawOnColourMode } from './diagrams'
import { localizeLabels } from './labels'
import { closeMenusOnEscape } from './menus'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ApiReference', defineAsyncComponent(() => import('./ApiReference.vue')))
  },
  setup() {
    const route = useRoute()
    onMounted(() => {
      localizeLabels()
      closeMenusOnEscape()
      redrawOnColourMode()
      drawDiagrams()
    })
    watch(() => route.path, () => nextTick(drawDiagrams))
  },
}
