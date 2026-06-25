import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { setCurrency } from './lib/format'
import { getSetting } from './lib/db'
import { initTheme } from './lib/theme'
import { refreshLicense } from './lib/license'
import { info, warn, error as logError, attachConsole } from '@tauri-apps/plugin-log'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { appLogDir, join } from '@tauri-apps/api/path'

// Xatolar uchun alohida fayl: <appLogDir>/errors.log
let errLogPath = ''
appLogDir().then((d) => join(d, 'errors.log')).then((p) => (errLogPath = p)).catch(() => {})
async function appendErr(line: string) {
  void logError(line) // umumiy logga ham
  if (!errLogPath) return
  try { await writeTextFile(errLogPath, `[${new Date().toISOString()}] ${line}\n`, { append: true }) } catch {}
}

// Rust loglarini webview konsoliga; JS xatolarini faylga.
attachConsole().catch(() => {})
window.addEventListener('error', (e) => { void appendErr(`window.error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`) })
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const r: any = e.reason
  void appendErr(`unhandledrejection: ${r?.stack ?? r?.message ?? String(r)}`)
})
const _err = console.error
console.error = (...a: any[]) => { _err(...a); void appendErr(a.map((x) => (x?.stack ?? String(x))).join(' ')) }

// Chunk/preload yuklanmasa (eski cache yoki yangilash) — bir marta avtomatik reload.
window.addEventListener('vite:preloadError', (e: any) => {
  void appendErr(`preload error: ${e?.payload?.message ?? e?.message ?? 'unknown'}`)
  if (sessionStorage.getItem('preloadReloaded')) return
  sessionStorage.setItem('preloadReloaded', '1')
  window.location.reload()
})

void info(`boot start · ${navigator.userAgent}`)
initTheme()

const app = createApp(App)
app.use(router)

// Litsenziyani mount'dan oldin yuklash (guard to'g'ri ishlashi uchun)
refreshLicense()
  .then((l) => void info(`license ok · mode=${l.mode} days=${l.daysLeft}`))
  .catch((e) => void appendErr(`license init error: ${e?.stack ?? e}`))
  .finally(() => {
    try {
      app.mount('#app')
      void info('app mounted')
    } catch (e: any) {
      void appendErr(`mount error: ${e?.stack ?? e}`)
    }
  })

// Valyuta belgisini sozlamadan o'qish
getSetting('currency_symbol', "so'm").then(setCurrency).catch((e) => void warn(`currency read: ${e}`))
