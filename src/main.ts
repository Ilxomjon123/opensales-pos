import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { setCurrency } from './lib/format'
import { getSetting } from './lib/db'
import { initTheme } from './lib/theme'
import { refreshLicense } from './lib/license'
import { applyPendingRestore } from './lib/backup'
import { i18n, loadLocale } from './lib/i18n'
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
app.use(i18n)

// 1) Kutilayotgan tiklash bo'lsa — DB ochilishidan OLDIN bajariladi.
// 2) Keyin litsenziya. 3) So'ng mount.
// MUHIM: applyPendingRestore() tugamaguncha HECH NARSA db() ni ochmasligi kerak.
// Aks holda db ESKI pos.db'ni ochib _dbp'ga cache qiladi, keyin restore fayl ustiga
// yozadi + wal/shm o'chiradi → ochiq connection buziladi → Device ID bo'sh, license xato.
// Shu sabab valyuta o'qishi ham shu zanjir ichida, restore'dan KEYIN.
// Litsenziyani ishonchli o'qish — vaqtinchalik DB xatosida qayta urinadi.
// Aks holda bitta transient xato litsenziyalangan foydalanuvchini "expired" ekraniга tashlaydi.
async function initLicense() {
  let lastErr: unknown
  for (let i = 0; i < 4; i++) {
    try { return await refreshLicense() }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 250 * (i + 1))) }
  }
  void appendErr(`license init error (retry tugadi): ${(lastErr as any)?.stack ?? lastErr}`)
  return null
}

applyPendingRestore()
  .catch((e) => void appendErr(`restore apply error: ${e?.stack ?? e}`))
  .then(() => initLicense())
  .then((l) => void info(`license ok · mode=${l?.mode ?? 'xato'} days=${l?.daysLeft ?? '-'}`))
  .then(() => loadLocale().catch((e) => void warn(`locale read: ${e}`)))
  .then(() => getSetting('currency_symbol', "so'm").then(setCurrency).catch((e) => void warn(`currency read: ${e}`)))
  .catch((e) => void appendErr(`init error: ${e?.stack ?? e}`))
  .finally(() => {
    try {
      app.mount('#app')
      void info('app mounted')
    } catch (e: any) {
      void appendErr(`mount error: ${e?.stack ?? e}`)
    }
  })
