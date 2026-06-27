import { ref } from 'vue'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { openUrl } from '@tauri-apps/plugin-opener'
import { getVersion } from '@tauri-apps/api/app'
import { isAndroid, isIOS } from './platform'

export const updateInfo = ref<{ version: string; notes: string } | null>(null)
export const updating = ref(false)
export const updateProgress = ref(0)
export const checking = ref(false)
let _update: Update | null = null

// Android uchun ochiq releases repo (APK shu yerda, desktop bilan bir joyda).
const RELEASES_REPO = 'Ilxomjon123/opensales-pos-releases'
let _androidApkUrl = ''

export type CheckResult = 'available' | 'latest' | 'offline' | 'error'

// "0.1.27" > "0.1.26" — semver son taqqoslash.
function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d }
  return 0
}

// Android: Tauri updater mobilda ishlamaydi. GitHub Releases API (CORS *) orqali
// oxirgi versiyani tekshiramiz; APK baytlarini webview CORS sababli yuklab bo'lmaydi,
// shu sabab o'rnatish brauzer orqali (openUrl → Android yuklab, o'rnatadi).
async function checkAndroid(): Promise<CheckResult> {
  if (!navigator.onLine) return 'offline'
  try {
    const res = await Promise.race([
      fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ])
    if (!res.ok) return 'error'
    const j: any = await res.json()
    const remoteVer = String(j.tag_name ?? '').replace(/^v/, '')
    if (!remoteVer) return 'error'
    const apk = (j.assets ?? []).find((a: any) => /_android\.apk$/i.test(a.name))
    let local = appVersionSafe()
    if (!local) local = await getVersion().catch(() => '')
    if (apk && local && cmpVer(remoteVer, local) > 0) {
      _androidApkUrl = apk.browser_download_url
      updateInfo.value = { version: remoteVer, notes: j.body ?? '' }
      return 'available'
    }
    updateInfo.value = null
    return 'latest'
  } catch (e: any) {
    return e?.message === 'timeout' || !navigator.onLine ? 'offline' : 'error'
  }
}

// appVersion'ni updater ichida import qilmaslik uchun (sikl) — getVersion fallback.
let _appVer = ''
getVersion().then((v) => (_appVer = v)).catch(() => {})
function appVersionSafe() { return _appVer }

// Yangi versiyani tekshiradi. Internetsizda osilmasligi uchun timeout bor.
export async function checkForUpdate(): Promise<CheckResult> {
  if (isIOS) return 'latest' // App Store orqali
  checking.value = true
  try {
    if (isAndroid) return await checkAndroid()
    if (!navigator.onLine) return 'offline'
    const u = await Promise.race([
      check(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ])
    if (u) { _update = u; updateInfo.value = { version: u.version, notes: u.body ?? '' }; return 'available' }
    updateInfo.value = null
    return 'latest'
  } catch (e: any) {
    return e?.message === 'timeout' || !navigator.onLine ? 'offline' : 'error'
  } finally {
    checking.value = false
  }
}

export async function installUpdate(): Promise<void> {
  // Android: APK'ni brauzerda ochamiz — yuklab olib, o'rnatish tizim installeriga o'tadi.
  if (isAndroid) {
    if (_androidApkUrl) await openUrl(_androidApkUrl)
    updateInfo.value = null
    return
  }
  if (isIOS || !_update) return
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
