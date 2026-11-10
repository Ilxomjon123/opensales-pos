import { nextTick, ref } from 'vue'
import type { Router } from 'vue-router'

// Sahifa almashish yo'nalishi va scroll xotirasi.
//
// Yangi sahifa CSS bilan paydo bo'ladi (style.css → .page-anim): bo'limlar orasida — yengil fade,
// ichkariga (/customers → /customers/2) — o'ngdan, orqaga — chapdan. Eski sahifa darhol
// ketadi: butun ekranni "suratga olib" crossfade qilish (View Transitions) bosishlarni ushlab
// turardi (hostel tajribasi) va iOS 17 webview'da yo'q.
export type NavDir = 'tab' | 'push' | 'pop'
export const navDir = ref<NavDir>('tab')

const depth = (p: string) => p.split('/').filter(Boolean).length
const scroller = () => document.querySelector('main')

export function installNav(router: Router) {
  const saved = new Map<string, number>()
  let back = false
  window.addEventListener('popstate', () => { back = true })

  router.beforeEach((to, from) => {
    const el = scroller()
    if (el && from.matched.length) saved.set(from.fullPath, el.scrollTop)
    const d = depth(to.path) - depth(from.path)
    navDir.value = !from.matched.length ? 'tab' : d > 0 ? 'push' : d < 0 ? 'pop' : 'tab'
  })

  router.afterEach(async (to, from, failure) => {
    const wasBack = back
    back = false
    if (failure || to.path === from.path) return
    await nextTick()
    const el = scroller()
    if (!el) return
    // Orqaga qaytilganda — avvalgi joy (ro'yxat keshdan bir zumda chiziladi); aks holda tepadan.
    const top = wasBack ? saved.get(to.fullPath) ?? 0 : 0
    el.scrollTop = top
    if (top > 0) setTimeout(() => { if (el.scrollTop < top) el.scrollTop = top }, 160)
  })
}
