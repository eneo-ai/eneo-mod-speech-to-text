import DefaultTheme from 'vitepress/theme-without-fonts'
import { nextTick, onMounted, watch } from 'vue'
import { useRoute } from 'vitepress'
import { drawDiagrams, redrawOnColourMode } from './diagrams'
import './custom.css'

export default {
  extends: DefaultTheme,
  setup() {
    const route = useRoute()
    onMounted(() => {
      redrawOnColourMode()
      drawDiagrams()
    })
    watch(() => route.path, () => nextTick(drawDiagrams))
  },
}
