import { session, ensureFreshToken, reauth } from './session'
import { bumpData } from './freshness'

// Worker RPC klienti.
//
// Yozuvchi chaqiruvlar Idempotency-Key bilan: tarmoq uzilsa xuddi shu kalit bilan qayta
// yuboriladi (server birinchi javobni qaytaradi — ikkinchi chek yo'q). Natijasi noma'lum
// qolgan chaqiruvning kaliti eslab qolinadi: foydalanuvchi o'sha amalni qayta bossa ham
// yangi kalit EMAS, o'sha kalit ketadi (backend'da 2026-10-31 dagi dublikat chek saboq).

export class RpcError extends Error {
  readonly code: string
  readonly params: Record<string, unknown>
  readonly status: number
  constructor(code: string, params: Record<string, unknown> = {}, status = 0) {
    super(code)
    this.name = 'RpcError'
    this.code = code
    this.params = params
    this.status = status
  }
}

export const NETWORK = 'cloud.errors.network'

const UNRESOLVED_KEY = 'kassa:unresolved'
type Unresolved = Record<string, string>

function loadUnresolved(): Unresolved {
  try { return JSON.parse(sessionStorage.getItem(UNRESOLVED_KEY) || '{}') } catch { return {} }
}
function saveUnresolved(u: Unresolved) {
  try { sessionStorage.setItem(UNRESOLVED_KEY, JSON.stringify(u)) } catch { /* to'la — e'tiborsiz */ }
}

function newKey(): string {
  return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}`, ...headers },
    body: JSON.stringify(body),
  })
}

type Opts = { write?: boolean }

// Ma'lum yozuvchi op'lar (o'qishlar retry'da kalitsiz).
const WRITE_OPS = new Set([
  'setSetting', 'saveCategory', 'deleteCategory', 'saveProduct', 'setProductActive', 'deleteProduct', 'bulkAdjustPrices',
  'setCustomerActive', 'deleteCustomer', 'recordCustomerPayment', 'saveCustomer', 'setCustomerBalance',
  'openShift', 'closeShift', 'createSale', 'saveExpense', 'deleteExpense',
  'create_return', 'create_customer_return', 'create_stock_receipt', 'void_stock_receipt', 'adjust_product_stock',
])

export async function call<T = unknown>(op: string, args: unknown, opts: Opts = {}): Promise<T> {
  const write = opts.write ?? WRITE_OPS.has(op)
  // Ko'rish rejimi: yozuv so'rovi umuman ketmaydi (server ham rad etadi — bu faqat tez va aniq xabar uchun).
  if (write && session.view) throw new RpcError('cloud.admin.viewOnly', {}, 403)
  const fp = write ? `${op}\u0000${JSON.stringify(args ?? null)}` : ''
  const unresolved = write ? loadUnresolved() : {}
  const key = write ? (unresolved[fp] ?? newKey()) : null
  const attempts = write ? 4 : 3
  let refreshed = false
  for (let i = 0; i < attempts; i++) {
    await ensureFreshToken()
    let res: Response
    try {
      res = await post(`/api/rpc/${op}`, { args }, key ? { 'Idempotency-Key': key } : {})
    } catch {
      // Javob kelmadi — server yozgan bo'lishi mumkin. Kalitni eslab, o'sha bilan qayta.
      if (write) { unresolved[fp] = key!; saveUnresolved(unresolved) }
      if (i < attempts - 1) { await sleep([400, 1200, 2500][i] ?? 2500); continue }
      throw new RpcError(NETWORK, {}, 0)
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true
      await reauth()
      i--
      continue
    }
    const json = (await res.json().catch(() => null)) as { ok: boolean; data?: T; error?: { code: string; params: Record<string, unknown>; status: number } } | null
    if (res.status >= 500 && write && i < attempts - 1 && json?.error?.code !== 'cloud.errors.internal') {
      unresolved[fp] = key!; saveUnresolved(unresolved)
      await sleep([400, 1200, 2500][i] ?? 2500)
      continue
    }
    // Aniq javob (muvaffaqiyat yoki domen xatosi) — kalit endi noma'lum emas.
    if (write && unresolved[fp]) { delete unresolved[fp]; saveUnresolved(unresolved) }
    if (json?.ok) {
      if (write) bumpData()
      return json.data as T
    }
    const e = json?.error
    if (e?.code === 'cloud.errors.subscriptionExpired') session.subscriptionActive = false
    if (e?.code === 'cloud.errors.memberRevoked') session.status = 'revoked'
    throw new RpcError(e?.code ?? 'cloud.errors.internal', e?.params ?? {}, res.status)
  }
  throw new RpcError(NETWORK, {}, 0)
}

/** Worker'ning RPC'dan tashqari endpointlari (xodimlar, eksport, chek). */
export async function api<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  await ensureFreshToken()
  let res: Response
  try { res = await post(path, body) } catch { throw new RpcError(NETWORK) }
  const json = (await res.json().catch(() => null)) as { ok: boolean; data?: T; error?: { code: string; params: Record<string, unknown> } } | null
  if (json?.ok) return json.data as T
  throw new RpcError(json?.error?.code ?? 'cloud.errors.internal', json?.error?.params ?? {}, res.status)
}

export async function upload(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  await ensureFreshToken()
  let res: Response
  try {
    res = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': contentType }, body: new Blob([bytes as BlobPart]) })
  } catch { throw new RpcError(NETWORK) }
  const json = (await res.json().catch(() => null)) as { ok: boolean; error?: { code: string; params: Record<string, unknown> } } | null
  if (!json?.ok) throw new RpcError(json?.error?.code ?? 'cloud.errors.internal', json?.error?.params ?? {}, res.status)
}

/** Xom tana (masalan, ovoz yozuvi) yuborib, JSON javob ma'lumotini oladi. */
export async function apiRaw<T = unknown>(path: string, body: Blob, contentType: string, extra: Record<string, string> = {}): Promise<T> {
  await ensureFreshToken()
  let res: Response
  try {
    res = await fetch(path, { method: 'POST', headers: { ...extra, Authorization: `Bearer ${session.token}`, 'Content-Type': contentType }, body })
  } catch { throw new RpcError(NETWORK) }
  const json = (await res.json().catch(() => null)) as { ok: boolean; data?: T; error?: { code: string; params: Record<string, unknown> } } | null
  if (json?.ok) return json.data as T
  throw new RpcError(json?.error?.code ?? 'cloud.errors.internal', json?.error?.params ?? {}, res.status)
}

/** `api` kabi, lekin xato bo'lsa ham javobdagi qo'shimcha maydonlarni (masalan, yangilangan qoralama) beradi. */
export async function apiFull<T = unknown>(path: string, body: unknown = {}): Promise<{ ok: true; data: T } | { ok: false; error: RpcError; extra: Record<string, unknown> }> {
  await ensureFreshToken()
  let res: Response
  try { res = await post(path, body) } catch { return { ok: false, error: new RpcError(NETWORK), extra: {} } }
  const json = (await res.json().catch(() => null)) as Record<string, any> | null
  if (json?.ok) return { ok: true, data: json.data as T }
  return { ok: false, error: new RpcError(json?.error?.code ?? 'cloud.errors.internal', json?.error?.params ?? {}, res.status), extra: json ?? {} }
}
