import { ref } from 'vue'
import { mkdir, readDir, readFile, remove, copyFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { relaunch } from '@tauri-apps/plugin-process'
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

// Tanlangan nusxani tiklash: pos.db ustiga yozib, ilovani qayta ishga tushirish.
export async function restoreBackup(name: string): Promise<void> {
  // WAL/SHM ni tozalab, nusxani asosiy bazaga ko'chiramiz.
  await copyFile(`${DIR}/${name}`, 'pos.db', { fromPathBaseDir: BaseDirectory.AppData, toPathBaseDir: BaseDirectory.AppData })
  await remove('pos.db-wal', { baseDir: BaseDirectory.AppData }).catch(() => {})
  await remove('pos.db-shm', { baseDir: BaseDirectory.AppData }).catch(() => {})
  await relaunch()
}

// ---- GitHub sync (faqat internet bo'lsa; token .env'da) ----
function bytesToB64(u: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < u.length; i += chunk) bin += String.fromCharCode(...u.subarray(i, i + chunk))
  return btoa(bin)
}

export async function syncToGithub(name: string): Promise<boolean> {
  const token = (import.meta.env.VITE_BACKUP_TOKEN ?? '').trim()
  const repo = (import.meta.env.VITE_BACKUP_REPO ?? '').trim() // "owner/repo"
  if (!token || !repo || !name || !navigator.onLine) return false
  syncing.value = true
  try {
    const bytes = await readFile(`${DIR}/${name}`, { baseDir: BaseDirectory.AppData })
    const device = await getDeviceId()
    const path = `backups/${device}/${name}`
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ message: `backup ${device} ${name}`, content: bytesToB64(bytes) }),
    })
    return res.ok
  } catch { return false } finally { syncing.value = false }
}
