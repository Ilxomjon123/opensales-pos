import { createApp, watch } from 'vue'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { installNav } from './nav'
import { routeAllowed } from './lib/auth'
import { i18n, loadLocale } from './lib/i18n'
import { initTheme } from './lib/theme'
import { initTelegram } from './telegram'
import { session, start } from './session'
import { setCurrency } from '../../src/lib/format'
import GlassSelect from './components/GlassSelect.vue'
import GlassDate from './components/GlassDate.vue'
import MoneyInput from './components/MoneyInput.vue'
import { RpcError } from './rpc'
import { notify } from '../../src/lib/notify'

initTelegram()
initTheme()

// Chunk yuklanmasa (yangi deploy, eski kesh) — bir marta qayta yuklash.
window.addEventListener('vite:preloadError', () => {
  try {
    if (sessionStorage.getItem('kassa:preloadReloaded')) return
    sessionStorage.setItem('kassa:preloadReloaded', '1')
  } catch { /* */ }
  window.location.reload()
})

// Admin ko'rish rejimi: desktop sahifalari ko'p yozuv xatosini o'zi ushlamaydi — "o'zgartirib bo'lmaydi" xabari
// shu yerda chiqadi (jim qolmasin). Boshqa xatolar avvalgidek konsolga.
// RpcError (rpc.ts) yoki desktop sahifalari uchun tarjima qilingan Error (`code` bilan — lib/db.ts).
const viewOnly = (e: unknown) => (e instanceof RpcError || e instanceof Error) && (e as { code?: unknown }).code === 'cloud.admin.viewOnly'
const sayViewOnly = () => notify(i18n.global.t('cloud.admin.viewOnly'), 'info')
window.addEventListener('unhandledrejection', (ev) => { if (viewOnly(ev.reason)) { ev.preventDefault(); sayViewOnly() } })

watch(() => session.settings.currency_symbol, (s) => { if (s) setCurrency(s) })

// Rol ma'lum bo'lgach: kassir egasi bo'limida qolgan bo'lsa (masalan, eski manzil) — kassaga.
watch(() => [session.status, session.user?.role] as const, ([st]) => {
  if (st === 'ok' && !routeAllowed(router.currentRoute.value.path)) router.replace('/pos')
})

;(async () => {
  await loadLocale()
  const app = createApp(App)
  // Sahifalardagi native <select>/<input type="date"> build'da shularga almashadi (vite.config.ts → cloudFields).
  app.component('GlassSelect', GlassSelect)
  app.component('GlassDate', GlassDate)
  app.component('MoneyInput', MoneyInput)
  app.config.errorHandler = (err, _vm, info) => {
    if (viewOnly(err)) { sayViewOnly(); return }
    console.error(err, info)
  }
  app.use(i18n)
  installNav(router)
  app.use(router)
  app.mount('#app')
  await start()
  // Sahifa kodlarini bo'sh vaqtda oldindan yuklash — birinchi o'tishda chunk kutilmasin (silliq).
  const idle = (cb: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 1200))
  idle(() => {
    for (const r of router.getRoutes()) {
      const c = r.components?.default
      if (typeof c === 'function') (c as () => Promise<unknown>)().catch(() => { /* tarmoq — keyin o'zi yuklanadi */ })
    }
  })
})()
