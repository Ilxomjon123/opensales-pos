import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { setCurrency } from './lib/format'
import { getSetting } from './lib/db'
import { initTheme } from './lib/theme'
import { refreshLicense } from './lib/license'
import { info, warn, error as logError, attachConsole } from '@tauri-apps/plugin-log'

// Rust loglarini webview konsoliga; JS xatolarini faylga.
attachConsole().catch(() => {})
window.addEventListener('error', (e) => { void logError(`window.error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`) })
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const r: any = e.reason
  void logError(`unhandledrejection: ${r?.stack ?? r?.message ?? String(r)}`)
})
const _err = console.error
console.error = (...a: any[]) => { _err(...a); void logError(a.map((x) => (x?.stack ?? String(x))).join(' ')) }

void info(`boot start · ${navigator.userAgent}`)
initTheme()

const app = createApp(App)
app.use(router)

// Litsenziyani mount'dan oldin yuklash (guard to'g'ri ishlashi uchun)
refreshLicense()
  .then((l) => void info(`license ok · mode=${l.mode} days=${l.daysLeft}`))
  .catch((e) => void logError(`license init error: ${e?.stack ?? e}`))
  .finally(() => {
    try {
      app.mount('#app')
      void info('app mounted')
    } catch (e: any) {
      void logError(`mount error: ${e?.stack ?? e}`)
    }
  })

// Valyuta belgisini sozlamadan o'qish
getSetting('currency_symbol', "so'm").then(setCurrency).catch((e) => void warn(`currency read: ${e}`))
