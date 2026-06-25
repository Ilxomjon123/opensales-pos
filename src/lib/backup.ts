import { ref } from 'vue'
import { mkdir, readDir, readFile, writeFile, writeTextFile, readTextFile, exists, remove, copyFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { relaunch } from '@tauri-apps/plugin-process'
import { hostname } from '@tauri-apps/plugin-os'
import { db, getSetting, setSetting } from './db'
import { getDeviceId } from './license'

const KEEP = 14 // oxirgi 14 kunlik nusxa saqlanadi
const DIR = 'backups'
export const lastBackup = ref('')
export const syncing = ref(false)

function today() { return new Date().toISOString().slice(0, 10) }
function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') }

export type BackupFile = { name: string; date: string }

export async function listBackups(): Promise<BackupFile[]> {
  try {
    const items = await readDir(DIR, { baseDir: BaseDirectory.AppData })
    return items
      .filter((e) => e.isFile && e.name.endsWith('.db'))
      .map((e) => ({ name: e.name, date: e.name.replace(/^pos-|\.db$/g, '') }))
      .sort((a, b) => (a.name < b.name ? 1 : -1))
  } catch { return [] }
}

// Bitta nusxa olish (VACUUM INTO — WAL bilan toza nusxa). Online bo'lsa GitHub'ga sync.
export async function makeBackup(): Promise<string> {
  await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => {})
  const name = `pos-${stamp()}.db`
  const abs = await join(await appDataDir(), DIR, name)
  const d = await db()
  await d.execute(`VACUUM INTO '${abs.replace(/'/g, "''")}'`)
  await setSetting('last_backup_date', today())
  lastBackup.value = name
  await prune()
  void syncToGithub(name)
  return name
}

async function prune() {
  const files = await listBackups()
  for (const f of files.slice(KEEP)) await remove(`${DIR}/${f.name}`, { baseDir: BaseDirectory.AppData }).catch(() => {})
}

// Kuniga bir marta (ilova ochilganda) avtomatik.
export async function runDueBackup(): Promise<void> {
  const last = await getSetting('last_backup_date', '')
  lastBackup.value = (await listBackups())[0]?.name ?? ''
  if (last !== today()) await makeBackup().catch(() => {})
  else void syncToGithub(lastBackup.value) // kun ichida online bo'lsa ham sync urinish
}

// Tiklash: ochiq DB faylini ustiga yozib bo'lmaydi (oq ekran). Shuning uchun marker
// yozib, qayta ishga tushiramiz; almashtirish boot'da, DB ochilishidan OLDIN bo'ladi.
const PENDING = 'restore_pending'
export async function restoreBackup(name: string): Promise<void> {
  await writeTextFile(PENDING, name, { baseDir: BaseDirectory.AppData })
  await relaunch()
}

// Boot'da chaqiriladi (main.ts) — DB ochilishidan oldin.
export async function applyPendingRestore(): Promise<void> {
  try {
    if (!(await exists(PENDING, { baseDir: BaseDirectory.AppData }))) return
    const name = (await readTextFile(PENDING, { baseDir: BaseDirectory.AppData })).trim()
    if (name && (await exists(`${DIR}/${name}`, { baseDir: BaseDirectory.AppData }))) {
      await copyFile(`${DIR}/${name}`, 'pos.db', { fromPathBaseDir: BaseDirectory.AppData, toPathBaseDir: BaseDirectory.AppData })
      await remove('pos.db-wal', { baseDir: BaseDirectory.AppData }).catch(() => {})
      await remove('pos.db-shm', { baseDir: BaseDirectory.AppData }).catch(() => {})
    }
    await remove(PENDING, { baseDir: BaseDirectory.AppData }).catch(() => {})
  } catch {}
}

// ---- GitHub sync (faqat internet bo'lsa; token .env'da) ----
function bytesToB64(u: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < u.length; i += chunk) bin += String.fromCharCode(...u.subarray(i, i + chunk))
  return btoa(bin)
}

// ---- GitHub'dan tiklash (yangi komp / qayta o'rnatish) ----
const GH = 'https://api.github.com'
function ghCfg() {
  return {
    token: (import.meta.env.VITE_BACKUP_TOKEN ?? '').trim(),
    repo: (import.meta.env.VITE_BACKUP_REPO ?? '').trim(),
  }
}
async function ghJson(path: string): Promise<any[]> {
  const { token, repo } = ghCfg()
  if (!token || !repo) return []
  const res = await fetch(`${GH}/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) return []
  const j = await res.json()
  return Array.isArray(j) ? j : []
}

export type GhDevice = { id: string; label: string; shop: string; host: string }
async function ghRaw(path: string): Promise<string | null> {
  const { token, repo } = ghCfg()
  if (!token || !repo) return null
  const res = await fetch(`${GH}/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw' },
  })
  return res.ok ? await res.text() : null
}

// GitHub'dagi barcha qurilmalar — do'kon nomi bilan (qaysi uniki ekanini bilish uchun)
export async function githubDevices(): Promise<GhDevice[]> {
  const dirs = (await ghJson('backups')).filter((i) => i.type === 'dir').map((i) => i.name as string)
  const out: GhDevice[] = []
  for (const id of dirs) {
    let shop = '', host = ''
    try { const t = await ghRaw(`backups/${id}/_info.json`); if (t) { const j = JSON.parse(t); shop = j.shop_name ?? ''; host = j.host ?? '' } } catch {}
    const parts = [shop, host].filter(Boolean)
    out.push({ id, shop, host, label: parts.length ? `${parts.join(' · ')} · ${id}` : id })
  }
  return out
}
// Bitta qurilmaning nusxalari
export async function githubBackups(device: string): Promise<BackupFile[]> {
  return (await ghJson(`backups/${device}`))
    .filter((i) => i.name.endsWith('.db'))
    .map((i) => ({ name: i.name, date: i.name.replace(/^pos-|\.db$/g, '') }))
    .sort((a, b) => (a.name < b.name ? 1 : -1))
}
// Tanlangan nusxani GitHub'dan yuklab, tiklash (raw — har qanday hajm)
export async function githubRestore(device: string, name: string): Promise<void> {
  const { token, repo } = ghCfg()
  const res = await fetch(`${GH}/repos/${repo}/contents/backups/${device}/${name}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw' },
  })
  if (!res.ok) throw new Error('Yuklab bo\'lmadi (' + res.status + ')')
  const buf = new Uint8Array(await res.arrayBuffer())
  await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => {})
  await writeFile(`${DIR}/${name}`, buf, { baseDir: BaseDirectory.AppData })
  await restoreBackup(name)
}

async function ghPut(path: string, contentB64: string, message: string): Promise<boolean> {
  const { token, repo } = ghCfg()
  if (!token || !repo) return false
  let sha: string | undefined
  const head = await fetch(`${GH}/repos/${repo}/contents/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })
  if (head.ok) { try { sha = (await head.json()).sha } catch {} }
  const res = await fetch(`${GH}/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ message, content: contentB64, ...(sha ? { sha } : {}) }),
  })
  return res.ok
}

export async function syncToGithub(name: string): Promise<boolean> {
  const { token, repo } = ghCfg()
  if (!token || !repo || !name || !navigator.onLine) return false
  syncing.value = true
  try {
    const device = await getDeviceId()
    const bytes = await readFile(`${DIR}/${name}`, { baseDir: BaseDirectory.AppData })
    const ok = await ghPut(`backups/${device}/${name}`, bytesToB64(bytes), `backup ${device} ${name}`)
    // Do'kon nomi (qaysi qurilma ekanini bilish uchun)
    const shop = await getSetting('shop_name', '')
    let host = ''
    try { host = (await hostname()) ?? '' } catch {}
    const info = JSON.stringify({ device, shop_name: shop, host, updated: new Date().toISOString(), last_file: name })
    await ghPut(`backups/${device}/_info.json`, bytesToB64(new TextEncoder().encode(info)), `info ${device}`)
    return ok
  } catch { return false } finally { syncing.value = false }
}
