import { reactive } from 'vue'
import { tg, requestWriteAccess } from './telegram'

// Kirish holati. initData faqat kirishda yuboriladi; keyin qisqa muddatli token
// (sessionStorage — Telegram oynasi yopilsa o'chadi). Token muddati tugashiga yaqin
// /api/session/refresh, u ham o'tmasa — initData bilan qaytadan.

export type Role = 'owner' | 'cashier'
export type Status = 'loading' | 'ok' | 'new' | 'noTelegram' | 'revoked' | 'error'

/** Joriy do'kon. `catalogOf` — filial: katalog shu (asosiy) do'kondan. */
export type ShopInfo = { id: string; name: string; group?: string; catalogOf?: string | null; catalogOfName?: string | null }
/** Userning faol do'konlari (bir nechta do'kon — 2026-11-09). */
export type ShopListItem = { id: string; name: string; role: Role; group: string; root: boolean; catalogOf: string | null; catalogOfName: string | null }

export type Subscription = { trialUntil: string; paidUntil: string | null; status: 'active' | 'blocked'; active: boolean }

type SessionResponse = {
  ok: boolean
  status: 'ok' | 'new'
  token?: string
  user: { uid: number; name: string; role?: Role }
  shop?: ShopInfo
  shops?: ShopListItem[]
  member?: { role: Role } | null
  subscription?: Subscription | null
  settings?: Record<string, string>
  error?: { code: string; params?: Record<string, unknown> }
}

export const session = reactive({
  status: 'loading' as Status,
  token: '',
  exp: 0,
  user: null as null | { uid: number; name: string; role: Role },
  shop: null as null | ShopInfo,
  shops: [] as ShopListItem[],
  subscription: null as Subscription | null,
  subscriptionActive: true,
  settings: {} as Record<string, string>,
  error: '' as string,
  errorParams: {} as Record<string, unknown>,
  newUserName: '',
  /** Platforma boti (masalan, ovozni botga yuborish havolasi uchun). */
  bot: '',
  /** Platforma admini (ADMIN_CHAT_ID) — "Ko'proq"da Admin bo'limi. Huquqni server tekshiradi. */
  admin: false,
  /** AI yordamchi shu do'kon uchun yoqilganmi (admin o'chira oladi). */
  ai: true,
  /** Platforma admini boshqa do'konni KO'RISH rejimida (faqat o'qish; server yozishni rad etadi). */
  view: null as null | { owner: string },
  /** Do'kon boshlang'ich holati (tovar/sotuv/smena soni) — "Boshlash" kartasi va birinchi smena. */
  progress: null as null | ShopProgress,
  /** Bot egaga yoza oladimi (false — ruxsat so'raladi; null — noma'lum yoki kassir, so'ralmaydi). */
  pm: null as null | boolean,
})

export type ShopProgress = { products: number; sales: number; shifts: number; firstSaleAt: string | null; lastSaleAt: string | null; day2At: string | null }

const TOKEN_KEY = 'kassa:token'

function tokenExp(token: string): number {
  try {
    const body = token.split('.')[1]
    const p = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
    return Number(p.exp) || 0
  } catch { return 0 }
}

function apply(r: SessionResponse) {
  if (r.status === 'new') {
    session.status = 'new'
    session.newUserName = r.user?.name ?? ''
    return
  }
  session.token = r.token ?? ''
  session.exp = tokenExp(session.token)
  try { sessionStorage.setItem(TOKEN_KEY, session.token) } catch { /* */ }
  session.user = { uid: r.user.uid, name: r.user.name, role: (r.user.role ?? 'cashier') as Role }
  session.shop = r.shop ?? null
  session.shops = r.shops ?? []
  session.subscription = r.subscription ?? null
  session.subscriptionActive = r.subscription?.active ?? true
  session.settings = r.settings ?? {}
  const bot = (r as unknown as { bot?: unknown }).bot
  session.bot = typeof bot === 'string' ? bot : ''
  session.admin = (r as unknown as { admin?: unknown }).admin === true
  session.ai = (r as unknown as { ai?: unknown }).ai !== false
  const view = (r as unknown as { view?: { owner?: unknown } }).view
  session.view = view && typeof view === 'object' ? { owner: typeof view.owner === 'string' ? view.owner : '' } : null
  const pr = (r as unknown as { progress?: ShopProgress | null }).progress
  session.progress = pr && typeof pr === 'object' && typeof pr.products === 'number' ? pr : null
  const pm = (r as unknown as { pm?: unknown }).pm
  // Token bilan yangilashda ham server javob beradi; bu klientda allaqachon ruxsat berilgan bo'lsa — o'zgarmaydi.
  session.pm = session.pm === true ? true : typeof pm === 'boolean' ? pm : null
  session.status = 'ok'
}

let initDataCache: string | null = null
async function initData(): Promise<string> {
  if (initDataCache) return initDataCache
  if (tg?.initData) return (initDataCache = tg.initData)
  // Lokal dev: Vite middleware test bot tokeni bilan imzolaydi (prod build'da bu shox yo'q).
  if (import.meta.env.DEV) {
    const q = new URLSearchParams(location.search)
    const params = new URLSearchParams({ uid: q.get('dev_uid') || localStorage.getItem('kassa:dev_uid') || '700000001', name: q.get('dev_name') || 'Dev Ega' })
    if (q.get('dev_uid')) localStorage.setItem('kassa:dev_uid', q.get('dev_uid')!)
    const r = await fetch(`/__dev/init-data?${params}`)
    if (r.ok) return (initDataCache = await r.text())
  }
  return ''
}

/** Taklif qabul qilingach manzildan olib tashlanadi (yangilashda qayta yuborilmasin, ulashilmasin). */
function dropInviteFromUrl() {
  const u = new URL(location.href)
  if (!u.searchParams.has('inv')) return
  u.searchParams.delete('inv')
  history.replaceState(history.state, '', u.pathname + u.search + u.hash)
}

function inviteFromUrl(): string | null {
  const inv = new URLSearchParams(location.search).get('inv')
  return inv && /^[a-f0-9]{32}$/.test(inv) ? inv : null
}

async function postJson(path: string, body: unknown, token?: string): Promise<{ status: number; json: SessionResponse | null }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as SessionResponse | null }
}

function fail(code: string, params: Record<string, unknown> = {}) {
  session.error = code
  session.errorParams = params
  session.status = code === 'cloud.errors.memberRevoked' ? 'revoked' : 'error'
}

/** Ilova ochilganda. */
export async function start(): Promise<void> {
  session.status = 'loading'
  const saved = (() => { try { return sessionStorage.getItem(TOKEN_KEY) } catch { return null } })()
  if (saved && tokenExp(saved) * 1000 > Date.now() + 60_000) {
    // Oldingi ochilishdagi token — bitta so'rov bilan holatni yangilaymiz.
    try {
      const r = await postJson('/api/session/refresh', {}, saved)
      if (r.json?.ok && r.json.status === 'ok') { apply(r.json); return }
    } catch { /* initData bilan davom */ }
  }
  await loginWithInitData()
}

async function loginWithInitData(): Promise<void> {
  const data = await initData()
  if (!data) { session.status = 'noTelegram'; return }
  try {
    const r = await postJson('/api/session', { initData: data, invite: inviteFromUrl() })
    if (r.json?.ok) { apply(r.json); dropInviteFromUrl() }
    else fail(r.json?.error?.code ?? 'cloud.errors.internal', r.json?.error?.params ?? {})
  } catch {
    fail('cloud.errors.network')
  }
}

export async function onboard(shopName: string): Promise<void> {
  const data = await initData()
  const r = await postJson('/api/onboard', { initData: data, shopName })
  if (r.json?.ok) apply(r.json)
  else throw new Error(r.json?.error?.code ?? 'cloud.errors.internal')
}

/**
 * Bot xabarlariga ruxsat (Telegram oynasi). Berilsa serverga aytiladi — eslatmalar va hisobotlar endi yetadi.
 * Qaytaradi: ruxsat bormi (null — bu klientda so'rab bo'lmaydi).
 */
export async function allowBotMessages(): Promise<boolean | null> {
  const granted = await requestWriteAccess()
  if (!granted) return granted
  session.pm = true
  const data = await initData()
  if (data) await postJson('/api/write-access', { initData: data, allowed: true }).catch(() => undefined)
  return true
}

let refreshing: Promise<void> | null = null

/** Token muddati tugashiga 5 daqiqadan kam qolsa — yangilaydi. */
export async function ensureFreshToken(): Promise<void> {
  if (!session.token || session.exp * 1000 > Date.now() + 5 * 60_000) return
  await reauth()
}

export async function reauth(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const r = await postJson('/api/session/refresh', {}, session.token)
      if (r.json?.ok && r.json.status === 'ok') { apply(r.json); return }
      if (r.status === 403) { fail('cloud.errors.memberRevoked'); return }
    } catch { /* tarmoq — keyingi so'rov qayta urinadi */ return }
    initDataCache = null
    await loginWithInitData()
  })().finally(() => { refreshing = null })
  return refreshing
}

export const isOwner = () => session.user?.role === 'owner'

/** Shu biznesdagi, user EGA bo'lgan do'konlar (ko'chirish, umumiy hisobot, yangi do'kon manbai). */
export function ownedShops(): ShopListItem[] {
  const group = session.shop?.group
  return session.shops.filter((x) => x.role === 'owner' && (!group || x.group === group))
}

/**
 * Do'kon almashtirish / yangi do'kon: yangi token saqlanadi va ilova toza holatda qayta ochiladi
 * (sahifa keshlari, savat, yordamchi chatlari — hammasi do'konga bog'liq).
 */
async function enterShop(path: string, body: unknown, to = '/pos'): Promise<void> {
  const r = await postJson(path, body, session.token)
  if (!r.json?.ok || !r.json.token) {
    const e = new Error(r.json?.error?.code ?? 'cloud.errors.internal') as Error & { params?: Record<string, unknown> }
    e.params = r.json?.error?.params ?? {}
    throw e
  }
  try { sessionStorage.setItem(TOKEN_KEY, r.json.token) } catch { /* */ }
  location.replace(to)
}

export function switchShop(shopId: string): Promise<void> {
  return enterShop('/api/session/switch', { shopId })
}

export function createShop(p: { name: string; catalogOf: string | null; copyFrom: string | null }): Promise<void> {
  return enterShop('/api/shops/create', p)
}

/** Admin: boshqa do'konni ko'rish rejimida ochish (a'zo bo'linmaydi, hech narsa yozilmaydi). */
export function viewShop(shopId: string): Promise<void> {
  // Kassa (smena, sotuv) ko'rish rejimida kerak emas — do'kon holati hisobotda.
  return enterShop('/api/admin/view', { id: shopId }, '/reports')
}

/** Ko'rish rejimidan chiqish — o'z do'koniga, Admin sahifasiga qaytadi. */
export function exitView(): Promise<void> {
  return enterShop('/api/admin/exit', {}, '/admin')
}
