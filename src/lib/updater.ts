import { ref } from 'vue'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export const updateInfo = ref<{ version: string; notes: string } | null>(null)
export const updating = ref(false)
export const updateProgress = ref(0)
export const checking = ref(false)
let _update: Update | null = null

// Internet bo'lganda yangi versiyani tekshiradi. Offline/xato — jim (false).
export async function checkForUpdate(): Promise<boolean> {
  checking.value = true
  try {
    const u = await check()
    if (u) { _update = u; updateInfo.value = { version: u.version, notes: u.body ?? '' }; return true }
    updateInfo.value = null
    return false
  } catch {
    return false // offline yoki endpoint yo'q
  } finally {
    checking.value = false
  }
}

export async function installUpdate(): Promise<void> {
  if (!_update) return
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
