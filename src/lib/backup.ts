import { ref } from 'vue'
import Database from '@tauri-apps/plugin-sql'
import { mkdir, readDir, readFile, writeFile, writeTextFile, readTextFile, exists, remove, copyFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { relaunch } from '@tauri-apps/plugin-process'
import { hostname } from '@tauri-apps/plugin-os'
import { db, getSetting, setSetting } from './db'
import { getDeviceId } from './license'

const KEEP = 14 // oxirgi 14 kunlik nusxa saqlanadi
const DIR = 'backups'
export const lastBackup = ref('')
export const lastSync = ref('') // oxirgi muvaffaqiyatli cloud sync vaqti (ISO)
export const syncing = ref(false)

// Sozlamadan oxirgi sync vaqtini yuklash (app ochilganda / Settings'da).
export async function loadLastSync(): Promise<void> { lastSync.value = await getSetting('last_sync_at', '') }

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

// Bitta nusxa olish (VACUUM INTO — WAL bilan toza nusxa). autoSync=true bo'lsa fonda
// GitHub'ga yuboriladi (kunlik avtomatik oqim). Qo'lda sync o'zi chaqiradi → autoSync=false.
export async function makeBackup(autoSync = true): Promise<string> {
  await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => {})
  const name = `pos-${stamp()}.db`
  const abs = await join(await appDataDir(), DIR, name)
  const d = await db()
  await d.execute(`VACUUM INTO '${abs.replace(/'/g, "''")}'`)
  await setSetting('last_backup_date', today())
  lastBackup.value = name
  await prune()
  if (autoSync) void syncToGithub(name)
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

// Backup faylidagi (alohida sqlite) PIN-kodni o'qish — tiklashdan OLDIN tekshirish uchun.
// null = fayl ochilmadi yoki PIN topilmadi (eski/buzuq nusxa).
export async function backupPin(name: string): Promise<string | null> {
  try {
    // `sqlite:` nisbiy yo'l appConfigDir'ga (mac/win'da == AppData) nisbatan ochiladi.
    // Bu fayl uchun migration ro'yxatga olinmagan → faqat ochiladi, o'zgartirilmaydi.
    const bdb = await Database.load(`sqlite:${DIR}/${name}`)
    try {
      const r = await bdb.select<{ value: string }[]>("SELECT value FROM settings WHERE key = 'auth_pin'")
      return r[0]?.value ?? null
    } finally { await bdb.close() }
  } catch { return null }
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

// ---- Cloud backup shifrlash (AES-GCM, parol = owner qo'ygan; serverda YO'Q) ----
// Lokal nusxa OCHIQ qoladi (tez tiklash). Faqat cloud'ga ketadigan nusxa shifrlanadi.
// Parol qo'yilmasa — shifrlash yo'q (ixtiyoriy). Format: magic(7)+salt(16)+iv(12)+ct.
const ENC_MAGIC = 'OSPENC1'
export async function backupPass(): Promise<string> { return getSetting('backup_pass', '') }
async function deriveKey(pass: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}
async function encryptBytes(plain: Uint8Array<ArrayBuffer>, pass: string): Promise<Uint8Array<ArrayBuffer>> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(pass, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
  const magic = new TextEncoder().encode(ENC_MAGIC)
  const out = new Uint8Array(magic.length + 16 + 12 + ct.length)
  out.set(magic, 0); out.set(salt, magic.length); out.set(iv, magic.length + 16); out.set(ct, magic.length + 28)
  return out
}
function isEncrypted(buf: Uint8Array): boolean {
  if (buf.length < 35) return false
  for (let i = 0; i < ENC_MAGIC.length; i++) if (buf[i] !== ENC_MAGIC.charCodeAt(i)) return false
  return true
}
async function decryptBytes(buf: Uint8Array<ArrayBuffer>, pass: string): Promise<Uint8Array<ArrayBuffer>> {
  const m = ENC_MAGIC.length
  const salt = buf.slice(m, m + 16), iv = buf.slice(m + 16, m + 28), ct = buf.slice(m + 28)
  const key = await deriveKey(pass, salt)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct))
}
// Yangi kompga tiklashda parol kerak bo'lsa shu sentinel tashlanadi (Settings prompt qiladi).
export const NEED_PASS = 'NEED_PASS'

// ---- Cloud backup proxy (Cloudflare Worker) ----
// GitHub token mijoz app'ida YO'Q — faqat Worker'da. POS Worker'ga device_id +
// imzolangan license_key yuboradi; Worker imzoni tekshirib, o'z tokeni bilan
// GitHub'ga boradi. Trial (kalit yo'q) → cloud o'chiq (faqat lokal backup).
function proxyBase(): string {
  return (import.meta.env.VITE_BACKUP_PROXY_URL ?? '').trim().replace(/\/+$/, '')
}
// Auth header: device_id + license_key. Kalit yo'q (trial) → null.
async function proxyAuth(): Promise<Record<string, string> | null> {
  const key = await getSetting('license_key', '')
  if (!key) return null
  const deviceId = await getDeviceId()
  return { 'X-Device-Id': deviceId, 'X-License-Key': key }
}
async function ghJson(path: string): Promise<any[]> {
  const base = proxyBase(); const h = await proxyAuth()
  if (!base || !h) return []
  const res = await fetch(`${base}/list?path=${encodeURIComponent(path)}`, { headers: h })
  if (!res.ok) return []
  const j = await res.json()
  return Array.isArray(j) ? j : []
}

export type GhDevice = { id: string; label: string; shop: string; host: string }
async function ghRaw(path: string): Promise<string | null> {
  const base = proxyBase(); const h = await proxyAuth()
  if (!base || !h) return null
  const res = await fetch(`${base}/raw?path=${encodeURIComponent(path)}`, { headers: h })
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
// Tanlangan nusxani GitHub'dan FAQAT lokalga yuklab olish (raw — har qanday hajm).
// Tiklash emas — PIN tekshiruvi shu yuklangan fayldan o'qilishi uchun ajratilgan.
// passOverride: boshqa kompda tiklashda owner master parol bilan ochish uchun.
export async function githubDownload(device: string, name: string, passOverride?: string): Promise<void> {
  const base = proxyBase(); const h = await proxyAuth()
  if (!base || !h) throw new Error('Cloud sozlanmagan yoki litsenziya yo\'q')
  const res = await fetch(`${base}/raw?path=${encodeURIComponent(`backups/${device}/${name}`)}`, { headers: h })
  if (!res.ok) throw new Error('Yuklab bo\'lmadi (' + res.status + ')')
  let buf = new Uint8Array(await res.arrayBuffer())
  // Shifrlangan bo'lsa — parol bilan ochamiz (parol device'ga bog'liq emas → boshqa kompda ham ishlaydi).
  if (isEncrypted(buf)) {
    const pass = (passOverride ?? '').trim() || await backupPass()
    if (!pass) throw new Error(NEED_PASS) // yangi komp — Settings parol so'raydi
    try { buf = await decryptBytes(buf, pass) } catch { throw new Error('Backup paroli noto\'g\'ri') }
  }
  // Yuklangan fayl haqiqiy SQLite ekanini tekshir (buzuq/qisqargan/HTML download swap qilinmasin → brick yo'q).
  const MAGIC = 'SQLite format 3\0'
  const okHdr = buf.length > 100 && Array.from(MAGIC).every((c, i) => buf[i] === c.charCodeAt(0))
  if (!okHdr) throw new Error("Yuklangan nusxa buzuq (SQLite emas). Qayta urinib ko'ring.")
  await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => {})
  await writeFile(`${DIR}/${name}`, buf, { baseDir: BaseDirectory.AppData })
}
// Yuklab + darhol tiklash (eski oqim — endi Settings download/verify/restore'ni alohida chaqiradi).
export async function githubRestore(device: string, name: string): Promise<void> {
  await githubDownload(device, name)
  await restoreBackup(name)
}

// Yuklash — Worker create-or-update (sha'ni server o'zi hal qiladi).
async function ghPut(path: string, contentB64: string, message: string): Promise<boolean> {
  const base = proxyBase(); const h = await proxyAuth()
  if (!base || !h) return false
  const res = await fetch(`${base}/put?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: contentB64, message }),
  })
  return res.ok
}

export async function syncToGithub(name: string): Promise<boolean> {
  const base = proxyBase()
  if (!base || !name || !navigator.onLine) return false
  if (!(await proxyAuth())) return false // trial / litsenziyasiz → cloud yo'q
  syncing.value = true
  try {
    const device = await getDeviceId()
    let bytes = await readFile(`${DIR}/${name}`, { baseDir: BaseDirectory.AppData })
    // Parol qo'yilgan bo'lsa — cloud nusxa shifrlanadi (lokal nusxa ochiq qoladi).
    const pass = await backupPass()
    if (pass) bytes = await encryptBytes(bytes, pass)
    const ok = await ghPut(`backups/${device}/${name}`, bytesToB64(bytes), `backup ${device} ${name}`)
    // Do'kon nomi (qaysi qurilma ekanini bilish uchun)
    const shop = await getSetting('shop_name', '')
    let host = ''
    try { host = (await hostname()) ?? '' } catch {}
    const info = JSON.stringify({ device, shop_name: shop, host, updated: new Date().toISOString(), last_file: name })
    await ghPut(`backups/${device}/_info.json`, bytesToB64(new TextEncoder().encode(info)), `info ${device}`)
    if (ok) {
      const now = new Date().toISOString()
      await setSetting('last_sync_at', now)
      lastSync.value = now
    }
    return ok
  } catch { return false } finally { syncing.value = false }
}

// Qo'lda sync (Settings header tugmasi): bazadan YANGI nusxa olib, cloud'ga (GitHub) yuboradi.
export async function syncNow(): Promise<boolean> {
  const name = await makeBackup(false)
  return syncToGithub(name)
}
