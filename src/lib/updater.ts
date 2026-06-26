import { ref } from 'vue'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isMobile } from './platform'

export const updateInfo = ref<{ version: string; notes: string } | null>(null)
export const updating = ref(false)
export const updateProgress = ref(0)
export const checking = ref(false)
let _update: Update | null = null

export type CheckResult = 'available' | 'latest' | 'offline' | 'error'

// Yangi versiyani tekshiradi. Internetsizda osilmasligi uchun timeout bor.
export async function checkForUpdate(): Promise<CheckResult> {
  // Mobil (Android/iOS) yangilanish Play Store / App Store orqali — Tauri
  // updater mobil'da ishlamaydi, shu sabab o'tkazib yuboramiz.
  if (isMobile) return 'latest'
  if (!navigator.onLine) return 'offline'
  checking.value = true
  try {
    const u = await Promise.race([
      check(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ])
    if (u) { _update = u; updateInfo.value = { version: u.version, notes: u.body ?? '' }; return 'available' }
    updateInfo.value = null
    return 'latest'
  } catch (e: any) {
    // timeout / tarmoq xatosi → offline deb hisoblaymiz
    return e?.message === 'timeout' || !navigator.onLine ? 'offline' : 'error'
  } finally {
    checking.value = false
  }
}

export async function installUpdate(): Promise<void> {
  if (isMobile || !_update) return
  updating.value = true
  updateProgress.value = 0
  let total = 0
  let got = 0
  await _update.downloadAndInstall((ev) => {
    if (ev.event === 'Started') total = ev.data.contentLength ?? 0
    else if (ev.event === 'Progress') { got += ev.data.chunkLength; updateProgress.value = total ? Math.round((got / total) * 100) : 0 }
  })
  await relaunch()
}

export function dismissUpdate() { updateInfo.value = null }
