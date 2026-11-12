import type { Sql } from './sql'
import type { Actor, RpcResult } from './rpc'
import { EXPENSE_CATEGORIES, type Extraction, type Kind, type ShopHints, type Turn } from '../assistant/ai'
import { norm, rank, words } from '../assistant/match'
import { roundHalfAway } from './money'
import { answerReport, type AnswerLang, type ReportQuery } from './answers'

// AI yordamchisi — do'kon tomoni (Durable Object ichida, sinxron).
//
// Oqim: AI'dan kelgan `Extraction` (faqat matn) → `createDraft` bazadagi tovar/mijozga moslaydi,
// tekshiradi va QORALAMA sifatida saqlaydi (hech narsa yozilmaydi) → foydalanuvchi ko'radi,
// kerak bo'lsa tuzatadi → `applyDraft` oddiy op'ni (createSale, recordCustomerPayment, recordCustomerPayout, ...)
// `ai_<id>` idempotency kaliti bilan chaqiradi: o'sha huquq, obuna va qoldiq tekshiruvlari,
// ikki marta tasdiqlansa ham bitta yozuv.

export type Source = 'text' | 'voice' | 'bot_text' | 'bot_voice'
/** Ovozli xabar ko'rinishi (chat tarixida pufak chizish uchun): davomiylik va to'lqin (0..1). */
export type VoiceMeta = { ms: number; wave: number[] }
export type ProductOpt = { id: number; name: string; unit: string; price: number; stock: number }
export type CustomerOpt = { id: number; name: string; phone: string | null; balance: number }
export type DraftItem = {
  query: string
  productId: number | null
  name: string | null
  unit: string | null
  qty: number
  price: number | null
  /** Faqat "product" (yangi tovar): tannarx. */
  cost: number | null
  stock: number | null
  options: ProductOpt[]
  /** Narx foydalanuvchi so'zidan (katalogdan emas) — valyuta kursi bilan faqat shular o'tkaziladi. */
  said?: boolean
}
/** Yangi mijoz (kind "customer"): saldo turi — debt: u bizga qarz, credit: biz unga qarz. */
export type Person = { name: string; phone: string | null; kind: 'none' | 'debt' | 'credit'; amount: number | null }

export type Draft = {
  id: string
  kind: Kind
  status: 'new' | 'applied' | 'cancelled'
  source: Source
  transcript: string
  language: string | null
  currency: string
  /** Foydalanuvchi narxni qaysi valyutada aytgani (do'konnikidan farq qilsa — tuzatmaguncha bloklanadi). */
  spokenCurrency: string | null
  customerQuery: string | null
  customerId: number | null
  customerName: string | null
  customerOptions: CustomerOpt[]
  walkInId: number | null
  items: DraftItem[]
  people: Person[]
  method: 'cash' | 'card' | 'debt' | 'transfer'
  paid: number | null
  amount: number | null
  category: string | null
  supplier: string | null
  note: string | null
  question: string | null
  /** Bloklovchi va ogohlantiruvchi holatlar (i18n kalitlari: cloud.ai.issue.*). */
  issues: { code: string; params?: Record<string, unknown> }[]
  ready: boolean
  total: number
  allowed: boolean
  result: Record<string, unknown> | null
  createdAt: string
  /** Shu qoralama tuzatgan (o'rnini egallagan) oldingi ochiq qoralama. */
  replaces?: string | null
  /** Bu qoralama keyingi tuzatish bilan almashtirildi (status 'cancelled'). */
  replacedBy?: string | null
  /** Bot chatidagi karta (almashtirilganda "yangilandi" deb tahrirlash uchun). `w` — widget karta (xabarning hamma amallari bitta kartada). */
  card?: { chat: number; msg: number; w?: 1 } | null
  /** Faqat javobda: ilova chati (yangi chat ochilgan bo'lsa — uning id'si). */
  chatId?: string
  /** Aytilgan mijoz bazada yo'q (o'xshashi ham yo'q) — tasdiqlashda shu nom bilan yaratiladi (faqat ega). */
  newCustomer?: string | null
  /** Hisobot savoli (kind "unknown"): javob `question` da — bazadan hisoblangan matn. */
  report?: { topic: ReportQuery['topic']; period: ReportQuery['period'] } | null
  /** Bitta xabardagi bir nechta amal: shu qoralama o'sha xabarning keyingi amali — birinchisining id'si. */
  partOf?: string | null
  /** Faqat javobda (bazada emas): narx boshqa valyutada aytilgan bo'lsa — taklif qilingan kurs (assistant/fx.ts). */
  fx?: { from: string; to: string; rate: number; source: 'saved' | 'cbu'; date: string | null } | null
}

/** Foydalanuvchi tasdiqlashdan oldin tuzatishi mumkin bo'lgan maydonlar. */
export type DraftEdits = {
  customerId?: number | null
  items?: { productId: number; qty: number; price?: number | null }[]
  method?: Draft['method']
  paid?: number | null
  amount?: number | null
  category?: string | null
  supplier?: string | null
  note?: string | null
  /** Faqat "product": yangi tovarlar ro'yxati (id yo'q — hali bazada emas). */
  newItems?: { name: string; price: number | null; cost: number | null; unit: string | null; qty: number }[]
  /** Faqat "customer": yangi mijozlar. */
  people?: Person[]
  /** Boshqa valyutada aytilgan narx/summalarni shu kurs bilan do'kon valyutasiga o'tkazish (1 aytilgan = rate do'kon). */
  rate?: number
  /** Mijozni yangi sifatida yaratish (nom) yoki bekor qilish (null). */
  newCustomer?: string | null
  /** Bitta tovar qatori (bot widget'i): tovarni tanlash, miqdor (0 — olib tashlash) yoki narx. Qolgan qatorlar tegilmaydi. */
  item?: { index: number; productId?: number; qty?: number; price?: number }
  /** Bitta yangi mijoz qatori ("customer"): saldo summasi yoki olib tashlash. */
  person?: { index: number; amount?: number; remove?: boolean }
}

/** Amal emas, savol/javob (tushunilmadi, hisobot, tovar/mijoz aytilmadi) — tasdiqlanadigan narsa yo'q. */
export const isChatOnly = (d: Draft) => d.kind === 'unknown' || ((d.kind === 'sale' || d.kind === 'receipt' || d.kind === 'product') && d.items.length === 0) || (d.kind === 'customer' && !(d.people ?? []).length)

export const DRAFT_TTL_MS = 24 * 3600_000
const ROLE_KINDS: Record<string, Kind[]> = { owner: ['sale', 'payment_in', 'payment_out', 'expense', 'receipt', 'product', 'customer'], cashier: ['sale'] }
/** Pul mijoz bilan harakatlanadigan amallar: payment_in — u bizga berdi (yoki biz qarz oldik), payment_out — biz unga qarz berdik. */
const isMoneyKind = (k: Kind) => k === 'payment_in' || k === 'payment_out'

/** Do'kon valyuta belgisi → ISO kod (noma'lum belgi — tekshirilmaydi). */
export function currencyCode(sym: string): string | null {
  const s = sym.trim().toLowerCase().replace(/[ʻʼ’`]/g, "'")
  if (/^(so'?m|сўм|сум|sum|uzs)$/.test(s)) return 'UZS'
  if (/^(\$|usd|dollar)$/.test(s)) return 'USD'
  if (/^(₽|rub|руб\.?|rubl)$/.test(s)) return 'RUB'
  if (/^(€|eur)$/.test(s)) return 'EUR'
  if (/^(₸|kzt|tenge)$/.test(s)) return 'KZT'
  return null
}

const CONTEXT_MS = 20 * 60_000
const CONTEXT_TURNS = 6
const CHAT_CONTEXT_TURNS = 8

/**
 * Suhbat konteksti: shu odamning oxirgi 20 daqiqadagi xabarlari va yordamchi nimani tushungani.
 * "Yuqoridagi tovarlarni", "o'shani" kabi gaplar shu bilan tushuniladi.
 */
export function historyTurns(sql: Sql, uid: number, now: string, chatId: string | null = null): Turn[] {
  // Ilova chatida — shu chatning oxirgi xabarlari (vaqt cheklovisiz: chatga qaytib davom etiladi); botda — 20 daqiqa.
  const rows = (chatId
    ? sql.all<{ transcript: string; draft: string; status: string }>(
      'SELECT transcript, draft, status FROM assistant_drafts WHERE uid = ? AND chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', uid, chatId, CHAT_CONTEXT_TURNS)
    : sql.all<{ transcript: string; draft: string; status: string }>(
      'SELECT transcript, draft, status FROM assistant_drafts WHERE uid = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      uid, new Date(Date.parse(now) - CONTEXT_MS).toISOString(), CONTEXT_TURNS)
  ).reverse()
  const turns: Turn[] = []
  for (const r of rows) {
    let d: Draft | null = null
    try { d = JSON.parse(r.draft) as Draft } catch { /* */ }
    // Bitta xabarning keyingi amallari (partOf) — foydalanuvchi xabari takrorlanmaydi, xulosa o'sha javobga qo'shiladi.
    const prev = turns.at(-1)
    const grouped = !!d?.partOf && prev?.role === 'assistant'
    if (!grouped) turns.push({ role: 'user', text: r.transcript })
    if (!d) continue
    const summary = {
      action: d.kind,
      status: r.status === 'new' ? 'open' : r.status === 'applied' ? 'saved' : d.replacedBy ? 'replaced' : 'cancelled',
      customer: d.customerName ?? d.customerQuery,
      items: d.items.map((i) => d.kind === 'product'
        ? { product: i.name ?? i.query, qty: i.qty, price: i.price, cost: i.cost, unit: i.unit }
        : { product: i.name ?? i.query, qty: i.qty, price: i.price }),
      people: (d.people ?? []).map((p) => ({ name: p.name, balance: p.kind, amount: p.amount })),
      amount: d.amount,
      currency: d.spokenCurrency,
      ...(d.report ? { report: d.report.topic, period: d.report.period } : {}),
      question: d.question,
    }
    if (grouped) prev!.text += '\n' + JSON.stringify(summary)
    else turns.push({ role: 'assistant', text: JSON.stringify(summary) })
  }
  return turns
}

export function randomDraftId(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** AI uchun do'kon lug'ati: oxirgi 60 kunda ko'p sotilganlar + qolgan faol tovarlar; mijozlar. */
export function shopHints(sql: Sql): ShopHints {
  const setting = (k: string, d: string) => sql.get<{ value: string | null }>('SELECT value FROM settings WHERE key = ?', k)?.value ?? d
  const products = sql.all<{ name: string }>(
    `SELECT p.name FROM products p
     LEFT JOIN (SELECT si.product_id, SUM(si.qty) q FROM sale_items si JOIN sales s ON s.id = si.sale_id
                WHERE s.created_at >= datetime('now', '-60 days') GROUP BY si.product_id) t ON t.product_id = p.id
     WHERE p.is_active = 1 ORDER BY COALESCE(t.q, 0) DESC, p.stock DESC LIMIT 80`,
  ).map((r) => r.name)
  const customers = sql.all<{ name: string }>('SELECT name FROM customers WHERE is_active = 1 AND is_walk_in = 0 ORDER BY id DESC LIMIT 60').map((r) => r.name)
  return { shopName: setting('shop_name', 'Do\'kon'), currency: setting('currency_symbol', "so'm"), products, customers }
}

function walkIn(sql: Sql): { id: number; name: string } | null {
  return sql.get<{ id: number; name: string }>('SELECT id, name FROM customers WHERE is_walk_in = 1 ORDER BY id LIMIT 1') ?? null
}

function allProducts(sql: Sql) {
  return sql.all<ProductOpt & { barcode: string | null; cost_price: number }>(
    'SELECT id, name, unit, price, stock, barcode, cost_price FROM products WHERE is_active = 1',
  )
}

function productOpt(p: ProductOpt): ProductOpt {
  return { id: p.id, name: p.name, unit: p.unit, price: Math.round(p.price), stock: p.stock }
}

function hasOpenShift(sql: Sql, uid: number): boolean {
  return !!sql.get("SELECT 1 FROM shifts WHERE status = 'open' AND user_id = ? LIMIT 1", uid)
}

const r2 = (n: number) => roundHalfAway(n)

/** Qoralama maydonlaridan holat: muammolar, tayyorlik, jami. Har o'zgarishda qayta hisoblanadi. */
export function evaluate(sql: Sql, d: Draft, actor: Actor): Draft {
  const issues: Draft['issues'] = []
  const allowed = (ROLE_KINDS[actor.role] ?? []).includes(d.kind)
  if (d.kind === 'unknown') issues.push({ code: 'unknown' })
  else if (!allowed) issues.push({ code: 'notAllowed' })
  const shopCode = currencyCode(d.currency)
  if (d.spokenCurrency && shopCode && d.spokenCurrency !== shopCode && d.kind !== 'unknown') {
    issues.push({ code: 'currencyMismatch', params: { said: d.spokenCurrency, shop: d.currency } })
  }

  if (d.kind === 'sale' || d.kind === 'receipt') {
    if (!d.items.length) issues.push({ code: 'noItems' })
    for (const it of d.items) {
      if (!it.productId) issues.push({ code: it.options.length ? 'pickProduct' : 'productNotFound', params: { name: it.query } })
      else if (d.kind === 'sale' && it.stock !== null && it.qty > it.stock + 1e-9) {
        const allowNeg = sql.get<{ value: string }>("SELECT value FROM settings WHERE key = 'allow_negative_stock'")?.value === '1'
        if (!allowNeg) issues.push({ code: 'insufficientStock', params: { name: it.name, stock: it.stock, unit: it.unit } })
      }
      if (d.kind === 'receipt' && it.productId && (it.price === null || it.price <= 0)) issues.push({ code: 'costMissing', params: { name: it.name } })
    }
  }
  if (d.kind === 'sale') {
    if (d.customerQuery && !d.customerId && !d.newCustomer) issues.push({ code: d.customerOptions.length ? 'pickCustomer' : 'customerNotFound', params: { name: d.customerQuery } })
    const isWalkIn = !d.newCustomer && (!d.customerId || d.customerId === d.walkInId)
    const total = d.items.reduce((s, it) => s + r2(it.qty * (it.price ?? 0)), 0)
    const paidNow = d.method === 'debt' ? (d.paid ?? 0) : (d.paid ?? total)
    if (isWalkIn && paidNow < total) issues.push({ code: 'debtNeedsCustomer' })
    if (!hasOpenShift(sql, actor.uid)) issues.push({ code: 'shiftNotOpen' })
  }
  if (isMoneyKind(d.kind)) {
    const needed = d.kind === 'payment_out' ? 'customerNeededOut' : 'customerNeeded'
    if (!d.newCustomer && (!d.customerId || d.customerId === d.walkInId)) issues.push({ code: d.customerOptions.length ? 'pickCustomer' : needed, params: { name: d.customerQuery } })
    if (!d.amount || d.amount <= 0) issues.push({ code: 'amountMissing' })
  }
  if (d.kind === 'expense' && (!d.amount || d.amount <= 0)) issues.push({ code: 'amountMissing' })
  if (d.kind === 'customer') {
    if (!d.people.length) issues.push({ code: 'noPeople' })
    const seenP = new Set<string>()
    for (const p of d.people) {
      const name = p.name.trim()
      if (!name) { issues.push({ code: 'nameMissing' }); continue }
      const key = name.toLowerCase()
      if (seenP.has(key) || sql.get('SELECT 1 FROM customers WHERE lower(trim(name)) = lower(?) LIMIT 1', name)) issues.push({ code: 'customerExists', params: { name } })
      seenP.add(key)
      if (p.kind !== 'none' && !(p.amount && p.amount > 0)) issues.push({ code: 'amountMissing' })
    }
  }
  if (d.kind === 'product') {
    if (!d.items.length) issues.push({ code: 'noItems' })
    const seen = new Set<string>()
    for (const it of d.items) {
      const name = (it.name ?? '').trim()
      if (!name) { issues.push({ code: 'nameMissing' }); continue }
      if (it.price === null || it.price <= 0) issues.push({ code: 'priceMissing', params: { name } })
      const key = name.toLowerCase()
      if (seen.has(key) || sql.get('SELECT 1 FROM products WHERE lower(trim(name)) = lower(?) LIMIT 1', name)) issues.push({ code: 'productExists', params: { name } })
      seen.add(key)
    }
  }

  const total = d.kind === 'sale' || d.kind === 'receipt' || d.kind === 'product'
    ? d.items.reduce((s, it) => s + r2(it.qty * (it.price ?? 0)), 0)
    : d.kind === 'customer' ? d.people.reduce((s, p) => s + (p.kind === 'debt' ? p.amount ?? 0 : 0), 0)
    : (d.amount ?? 0)
  // Ogohlantiruvchi (bloklamaydigan) — yo'q; hammasi bloklaydi, chunki noaniq yozuv pulga tegadi.
  return { ...d, issues, allowed, total, ready: d.status === 'new' && issues.length === 0 }
}

function resolveCustomer(sql: Sql, query: string | null) {
  if (!query) return { id: null, name: null, options: [] as CustomerOpt[] }
  const list = sql.all<CustomerOpt>('SELECT id, name, phone, balance FROM customers WHERE is_active = 1 AND is_walk_in = 0')
  const { top, confident } = rank(query, list, (c) => c.name, { extra: (c) => c.phone })
  if (confident) return { id: top[0].item.id, name: top[0].item.name, options: top.map((t) => t.item) }
  return { id: null, name: null, options: top.map((t) => t.item) }
}

/** AI natijasidan qoralama: moslash + tekshiruv. Hech narsa yozilmaydi (faqat qoralama jadvali). */
export function createDraft(sql: Sql, actor: Actor, p: { transcript: string; source: Source; extraction: Extraction; now: string; chatId?: string | null; voice?: VoiceMeta | null; lang?: AnswerLang; partOf?: string | null }): Draft {
  // Keyingi amal (partOf) — tuzatish bo'la olmaydi (eski ochiq kartani bekor qilib yubormasin).
  let x = p.partOf ? { ...p.extraction, revises: false } : p.extraction
  // Hisobot savoli: raqamlar bazadan (model to'qimaydi), javob matni — `question`. Mijoz/tovar nomi faqat savol
  // mavzusi — qoralamaga moslanmaydi (bu yozuv emas).
  let report: Draft['report'] = null
  if (x.report) {
    const lang: AnswerLang = x.language === 'ru' ? 'ru' : x.language === 'uz' ? 'uz' : p.lang ?? 'uz'
    const subject = x.report === 'customer' ? x.customer : x.report === 'stock' ? x.items[0]?.product ?? null : null
    const answer = answerReport(sql, actor, { topic: x.report, period: x.period, subject, said: p.transcript }, lang, p.now)
    report = { topic: x.report, period: x.period }
    x = { ...x, action: 'unknown', question: answer, items: [], people: [], customer: null, amount: null, revises: false, rate: null, currency: null }
  }
  const products = x.items.length && x.action !== 'product' ? allProducts(sql) : []
  // Foydalanuvchi AYTGAN so'zlar: model katalogdan aniq variantni (25W, #121) o'zi qo'shib qo'yishi
  // mumkin — raqamli belgi aytilmagan bo'lsa, tanlov asoslanmagan, o'xshashlardan tanlashga beriladi.
  const said = new Set(words(p.transcript))
  const items: DraftItem[] = x.action === 'product' ? x.items.map((it) => ({
    query: it.product, productId: null, name: it.product, unit: it.unit ?? 'dona', qty: it.qty ?? 0,
    price: it.price, cost: it.cost, stock: null, options: [], said: true,
  })) : x.items.map((it) => {
    const byBarcode = products.find((pr) => pr.barcode && norm(pr.barcode) === norm(it.product))
    let { top, confident } = byBarcode ? { top: [{ item: byBarcode, score: 1 }], confident: true } : rank(it.product, products, (pr) => pr.name)
    if (confident && !byBarcode) {
      const ungrounded = words(top[0].item.name).filter((w) => /\d/.test(w) && !said.has(w))
      if (ungrounded.length) {
        const base = words(it.product).filter((w) => !ungrounded.includes(w)).join(' ')
        const again = rank(base || it.product, products, (pr) => pr.name, { limit: 8 })
        const close = again.top.filter((c) => c.score >= again.top[0].score - 0.05)
        if (close.length > 1) { top = again.top; confident = false }
      }
    }
    const pick = confident ? top[0].item : null
    const qty = it.qty && it.qty > 0 ? it.qty : 1
    let price: number | null = null
    let saidPrice = false
    if (x.action === 'sale') {
      saidPrice = actor.role === 'owner' && !!it.price
      price = pick ? (saidPrice ? it.price : Math.round(pick.price)) : (actor.role === 'owner' ? it.price : null)
    }
    if (x.action === 'receipt') {
      saidPrice = it.price != null
      price = it.price ?? (pick && pick.cost_price > 0 ? Math.round(pick.cost_price) : null)
    }
    return {
      query: it.product,
      productId: pick?.id ?? null,
      name: pick?.name ?? null,
      unit: pick?.unit ?? null,
      qty,
      price,
      cost: null,
      stock: pick ? pick.stock : null,
      options: top.map((t) => productOpt(t.item)),
      said: saidPrice,
    }
  })
  const cust = resolveCustomer(sql, x.customer)
  // Ega aytgan mijoz bazada yo'q va o'xshashi ham yo'q — "yangi mijoz" (tasdiqlashda yaratiladi). O'xshashi bo'lsa —
  // tanlash (adashib dublikat ochilmasin); ilovada "yangi sifatida qo'shish" ham bor.
  const newCustomer = actor.role === 'owner' && (x.action === 'sale' || isMoneyKind(x.action)) && x.customer && !cust.id && !cust.options.length
    ? x.customer.trim().slice(0, 120) : null
  const wi = walkIn(sql)
  const category = x.category
    ? EXPENSE_CATEGORIES.find((c) => norm(c) === norm(x.category!)) ?? 'Boshqa'
    : (x.action === 'expense' ? 'Boshqa' : null)
  const method: Draft['method'] = isMoneyKind(x.action)
    ? (x.method === 'card' || x.method === 'transfer' ? x.method : 'cash')
    : (x.method === 'card' || x.method === 'debt' ? x.method : 'cash')

  let draft = evaluate(sql, {
    id: randomDraftId(),
    kind: x.action,
    status: 'new',
    source: p.source,
    transcript: p.transcript,
    language: x.language,
    currency: sql.get<{ value: string | null }>("SELECT value FROM settings WHERE key = 'currency_symbol'")?.value ?? "so'm",
    spokenCurrency: x.currency,
    customerQuery: x.customer,
    customerId: cust.id ?? (x.action === 'sale' && !x.customer ? wi?.id ?? null : null),
    customerName: cust.name ?? (x.action === 'sale' && !x.customer ? wi?.name ?? null : null),
    customerOptions: cust.options,
    walkInId: wi?.id ?? null,
    items,
    people: x.people.map((p) => ({
      name: p.name, phone: p.phone,
      kind: p.owes && p.owes > 0 ? 'debt' : p.owed && p.owed > 0 ? 'credit' : 'none',
      amount: p.owes && p.owes > 0 ? p.owes : p.owed && p.owed > 0 ? p.owed : null,
    })),
    method,
    paid: x.paid,
    amount: x.amount,
    category,
    supplier: x.supplier,
    note: x.note,
    question: x.question,
    issues: [],
    ready: false,
    total: 0,
    allowed: false,
    result: null,
    createdAt: p.now,
    newCustomer,
    report,
    ...(p.partOf ? { partOf: p.partOf } : {}),
  }, actor)
  // Kurs aytilgan ("dollar 12 mingdan") — aytilgan summalar shu kurs bilan darhol o'tkaziladi (deterministik, kurs eslab qolinadi).
  if (x.rate && draft.spokenCurrency) draft = applyEdits(sql, actor, draft, { rate: x.rate })
  // Tuzatish ("16 emas, 18 dedim"): model oldingi OCHIQ so'rovning to'liq yangi nusxasini beradi —
  // eskisi bekor qilinadi (tasodifan eskisini tasdiqlab yubormaslik uchun), yangisi uning o'rnini oladi.
  if (x.revises && draft.kind !== 'unknown') {
    const since = new Date(Date.parse(p.now) - (p.chatId ? DRAFT_TTL_MS : CONTEXT_MS)).toISOString()
    // Shu turdagi eng oxirgi ochiq qoralama (oradagi noto'g'ri tushunilgan boshqa turdagi karta emas); bo'lmasa — eng oxirgisi.
    // Ilova chatida — faqat shu chatdan.
    const prev = sql.get<{ id: string; draft: string }>(
      `SELECT id, draft FROM assistant_drafts WHERE uid = ? AND status = 'new' AND created_at >= ? AND (? IS NULL OR chat_id = ?)
       ORDER BY (kind = ?) DESC, created_at DESC LIMIT 1`, actor.uid, since, p.chatId ?? null, p.chatId ?? null, draft.kind,
    )
    if (prev) {
      let old: Draft | null = null
      try { old = JSON.parse(prev.draft) as Draft } catch { /* */ }
      if (old) markDraft(sql, { ...old, replacedBy: draft.id }, 'cancelled', null, p.now)
      draft.replaces = prev.id
    }
  }
  sql.run(
    'INSERT INTO assistant_drafts(id, uid, kind, status, transcript, draft, created_at, chat_id, voice) VALUES(?,?,?,?,?,?,?,?,?)',
    draft.id, actor.uid, draft.kind, 'new', draft.transcript, JSON.stringify(draft), p.now, p.chatId ?? null, p.voice ? JSON.stringify(p.voice) : null,
  )
  return draft
}

/** Pul qiymatlari izi — foydalanuvchi narx/summani haqiqatan o'zgartirdimi (valyuta ogohlantirishi uchun). */
function moneySig(d: Draft): string {
  return JSON.stringify([d.items.map((i) => [i.price, i.cost]), d.amount, d.paid, (d.people ?? []).map((p) => p.amount)])
}

/** Aytilgan valyutadagi narx/summalarni kurs bilan do'kon valyutasiga o'tkazadi (katalog narxlari tegilmaydi). */
function convertSpoken(d: Draft, rate: number): Draft {
  const whole = currencyCode(d.currency) === 'UZS'
  const c = (v: number | null) => (v == null ? v : whole ? Math.round(v * rate) : Math.round(v * rate * 100) / 100)
  return {
    ...d,
    items: d.items.map((it) => (it.said || d.kind === 'product' ? { ...it, price: c(it.price), cost: c(it.cost) } : it)),
    amount: c(d.amount),
    paid: c(d.paid),
    people: (d.people ?? []).map((p) => ({ ...p, amount: c(p.amount) })),
    spokenCurrency: null,
  }
}

const fxKey = (from: string, to: string) => `fx_${from}_${to}`
/** Do'konning shu juftlik uchun oxirgi ishlatgan kursi (chatdagi "o'tkazib saqlash" tugmasi uchun). */
export function fxSaved(sql: Sql, from: string, to: string): number | null {
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return null
  const v = Number(sql.get<{ value: string | null }>('SELECT value FROM settings WHERE key = ?', fxKey(from, to))?.value)
  return v > 0 ? v : null
}

export function loadDraft(sql: Sql, actor: Actor, id: string, now: string): Draft | null {
  if (!/^[a-f0-9]{16}$/.test(id)) return null
  const r = sql.get<{ uid: number; draft: string; created_at: string }>('SELECT uid, draft, created_at FROM assistant_drafts WHERE id = ?', id)
  if (!r || r.uid !== actor.uid) return null
  const d = JSON.parse(r.draft) as Draft
  if (d.status === 'new' && Date.parse(now) - Date.parse(r.created_at) > DRAFT_TTL_MS) return null
  return d.status === 'new' ? evaluate(sql, d, actor) : d
}

/** Tuzatishlarni qoralamaga qo'llaydi (id'lar bazadan qayta o'qiladi — klient nomi/narxiga ishonilmaydi). */
export function applyEdits(sql: Sql, actor: Actor, d: Draft, e: DraftEdits): Draft {
  let next: Draft = { ...d }
  if (e.people && d.kind === 'customer') {
    next.people = e.people.slice(0, 30).map((p) => ({
      name: p.name.trim().slice(0, 200), phone: p.phone?.trim().slice(0, 40) || null,
      kind: p.kind === 'debt' || p.kind === 'credit' ? p.kind : 'none', amount: p.amount != null && p.amount > 0 ? p.amount : null,
    }))
  }
  if (e.customerId !== undefined) {
    const c = e.customerId ? sql.get<CustomerOpt & { is_walk_in: number }>('SELECT id, name, phone, balance, is_walk_in FROM customers WHERE id = ? AND is_active = 1', e.customerId) : null
    next.customerId = c?.id ?? null
    next.customerName = c?.name ?? null
    if (c && !c.is_walk_in) next.customerQuery = next.customerQuery ?? c.name
    if (c) next.newCustomer = null
  }
  if (e.newCustomer !== undefined && (d.kind === 'sale' || isMoneyKind(d.kind))) {
    const name = actor.role === 'owner' ? e.newCustomer?.trim().slice(0, 120) || null : null
    next.newCustomer = name
    if (name) { next.customerId = null; next.customerName = null; next.customerQuery = name }
  }
  if (e.items) {
    next.items = e.items.slice(0, 50).flatMap((it) => {
      const p = sql.get<ProductOpt & { cost_price: number }>('SELECT id, name, unit, price, stock, cost_price FROM products WHERE id = ? AND is_active = 1', it.productId)
      if (!p || !(it.qty > 0)) return []
      const prev = d.items.find((x) => x.productId === p.id || x.options.some((o) => o.id === p.id))
      let price: number | null
      if (d.kind === 'receipt') price = it.price != null && it.price > 0 ? it.price : (p.cost_price > 0 ? Math.round(p.cost_price) : null)
      else price = actor.role === 'owner' && it.price != null && it.price >= 0 ? it.price : Math.round(p.price)
      return [{ query: prev?.query ?? p.name, productId: p.id, name: p.name, unit: p.unit, qty: it.qty, price, cost: null, stock: p.stock, options: prev?.options ?? [productOpt(p)], said: !!prev?.said && prev.price === price }]
    })
  }
  if (e.newItems && d.kind === 'product') {
    next.items = e.newItems.slice(0, 50).map((it) => ({
      query: it.name, productId: null, name: it.name.trim().slice(0, 200), unit: (it.unit ?? 'dona').slice(0, 20) || 'dona',
      qty: it.qty >= 0 ? it.qty : 0, price: it.price, cost: it.cost, stock: null, options: [], said: true,
    }))
  }
  if (e.item && Number.isInteger(e.item.index) && next.items[e.item.index]) {
    const i = e.item.index
    const items = next.items.slice()
    let it = { ...items[i] }
    if (e.item.productId && d.kind !== 'product') {
      const p = sql.get<ProductOpt & { cost_price: number }>('SELECT id, name, unit, price, stock, cost_price FROM products WHERE id = ? AND is_active = 1', e.item.productId)
      if (p) {
        const price = d.kind === 'receipt'
          ? (it.said && it.price != null ? it.price : p.cost_price > 0 ? Math.round(p.cost_price) : null)
          : (it.said && actor.role === 'owner' && it.price != null ? it.price : Math.round(p.price))
        it = { ...it, productId: p.id, name: p.name, unit: p.unit, stock: p.stock, price, options: it.options.length ? it.options : [productOpt(p)] }
      }
    }
    if (e.item.qty !== undefined) it.qty = e.item.qty
    // Narx: sotuvda faqat ega (kassir katalog narxida); yozilgan narx do'kon valyutasida — aytilgan emas.
    if (e.item.price !== undefined && e.item.price >= 0 && (d.kind !== 'sale' || actor.role === 'owner')) it = { ...it, price: e.item.price, said: false }
    if (it.qty > 0) items[i] = it
    else items.splice(i, 1)
    next.items = items
  }
  if (e.person && d.kind === 'customer' && Number.isInteger(e.person.index) && next.people[e.person.index]) {
    const people = next.people.slice()
    if (e.person.remove) people.splice(e.person.index, 1)
    else if (e.person.amount !== undefined) {
      const p = people[e.person.index]
      people[e.person.index] = { ...p, amount: e.person.amount > 0 ? e.person.amount : null, kind: e.person.amount > 0 ? (p.kind === 'none' ? 'debt' : p.kind) : 'none' }
    }
    next.people = people
  }
  if (e.method) next.method = e.method
  if (e.paid !== undefined) next.paid = e.paid
  if (e.amount !== undefined) next.amount = e.amount
  if (e.category !== undefined) next.category = EXPENSE_CATEGORIES.includes(e.category ?? '') ? e.category : 'Boshqa'
  if (e.supplier !== undefined) next.supplier = e.supplier?.slice(0, 120) ?? null
  if (e.note !== undefined) next.note = e.note?.slice(0, 300) ?? null
  // Foydalanuvchi narx/summani o'zi tuzatdi — valyuta ogohlantirishi o'z vazifasini bajardi. Faqat pul
  // qiymati HAQIQATAN o'zgarsa (nomni tuzatish dollar narxlarni so'm qilib saqlab yubormasin).
  if (next.spokenCurrency && moneySig(next) !== moneySig(d)) next.spokenCurrency = null
  const shopCode = currencyCode(next.currency)
  if (e.rate && e.rate > 0 && next.spokenCurrency && shopCode && next.spokenCurrency !== shopCode) {
    sql.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', fxKey(next.spokenCurrency, shopCode), String(e.rate))
    next = convertSpoken(next, e.rate)
  }
  return evaluate(sql, next, actor)
}

/** Tasdiqlangan qoralama → oddiy op chaqiruvi (op nomi va argumentlari). */
export function toOp(sql: Sql, actor: Actor, d: Draft): { op: string; args: unknown } {
  if (d.kind === 'sale') {
    const shift = sql.get<{ id: number }>("SELECT id FROM shifts WHERE status = 'open' AND user_id = ? ORDER BY id DESC LIMIT 1", actor.uid)
    const total = d.items.reduce((s, it) => s + r2(it.qty * (it.price ?? 0)), 0)
    const paidNow = Math.min(total, d.method === 'debt' ? (d.paid ?? 0) : (d.paid ?? total))
    return {
      op: 'createSale',
      args: [{
        shiftId: shift?.id ?? 0,
        customerId: d.customerId ?? d.walkInId,
        items: d.items.map((it) => ({ product_id: it.productId, qty: it.qty, price: it.price })),
        paidCash: d.method === 'card' ? 0 : paidNow,
        paidCard: d.method === 'card' ? paidNow : 0,
        discount: 0,
        note: d.note,
      }],
    }
  }
  if (d.kind === 'payment_in') return { op: 'recordCustomerPayment', args: [d.customerId, d.amount, d.method === 'debt' ? 'cash' : d.method, d.note] }
  if (d.kind === 'payment_out') return { op: 'recordCustomerPayout', args: [d.customerId, d.amount, d.method === 'debt' ? 'cash' : d.method, d.note] }
  if (d.kind === 'expense') return { op: 'saveExpense', args: [{ amount: d.amount, category: d.category ?? 'Boshqa', note: d.note }] }
  if (d.kind === 'customer') {
    return {
      op: 'assistant_create_customers',
      args: [{ people: d.people.map((p) => ({ name: p.name, phone: p.phone, balance: p.kind === 'debt' ? -(p.amount ?? 0) : p.kind === 'credit' ? p.amount ?? 0 : 0 })) }],
    }
  }
  if (d.kind === 'product') {
    return {
      op: 'assistant_create_products',
      args: [{ items: d.items.map((it) => ({ name: it.name, price: it.price, cost_price: it.cost ?? 0, unit: it.unit ?? 'dona', stock: it.qty })) }],
    }
  }
  return {
    op: 'create_stock_receipt',
    args: { request: { supplier: d.supplier, note: d.note, lines: d.items.map((it) => ({ productId: it.productId, qty: it.qty, costPrice: it.price, salePrice: null })) } },
  }
}

/** Natija — foydalanuvchiga ko'rsatiladigan qisqa ma'lumot. */
export function resultSummary(d: Draft, data: unknown): Record<string, unknown> {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  if (d.kind === 'sale') return { receiptNumber: o.receipt_number, total: o.total, debt: o.debt_amount }
  if (d.kind === 'receipt') return { receiptNumber: o.receiptNumber, total: o.total }
  if (d.kind === 'customer') return { count: Array.isArray(o.created) ? o.created.length : d.people.length }
  if (d.kind === 'product') {
    const created = Array.isArray(o.created) ? (o.created as { name: string }[]) : []
    return { count: created.length, names: created.map((c) => c.name).slice(0, 10) }
  }
  return { amount: d.amount }
}

export function markDraft(sql: Sql, d: Draft, status: 'applied' | 'cancelled', result: Record<string, unknown> | null, now: string) {
  const saved: Draft = { ...d, status, result, ready: false }
  sql.run('UPDATE assistant_drafts SET status = ?, draft = ?, applied_at = ? WHERE id = ?', status, JSON.stringify(saved), now, d.id)
  return saved
}

// ---- Bitta xabarning amallari (guruh): id = g yoki partOf = g. Bot widget kartasi shu guruhni ko'rsatadi.

export type GroupRow = { draft: Draft; expired: boolean }
const isOpen = (r: GroupRow) => r.draft.status === 'new' && !r.expired && !isChatOnly(r.draft)

/** Guruh qoralamalari (aytilgan tartibda); ochiqlari qayta baholanadi. Begona/yo'q guruh — bo'sh. */
export function groupDrafts(sql: Sql, actor: Actor, g: string, now: string): GroupRow[] {
  if (!/^[a-f0-9]{16}$/.test(g)) return []
  const rows = sql.all<{ draft: string; created_at: string }>(
    'SELECT draft, created_at FROM assistant_drafts WHERE uid = ? AND (id = ? OR draft LIKE ?) ORDER BY created_at, rowid', actor.uid, g, `%"partOf":"${g}"%`,
  )
  return rows.flatMap((r) => {
    let d: Draft
    try { d = JSON.parse(r.draft) as Draft } catch { return [] }
    if (d.id !== g && d.partOf !== g) return []
    const expired = d.status === 'new' && Date.parse(now) - Date.parse(r.created_at) > DRAFT_TTL_MS
    return [{ draft: d.status === 'new' && !expired ? evaluate(sql, d, actor) : d, expired }]
  })
}

export type GroupApply =
  | { ok: false; notReady: { index: number; draft: Draft }[]; rows: GroupRow[] }
  | { ok: true; results: { id: string; error: { code: string; params: Record<string, unknown> } | null }[]; rows: GroupRow[] }

/** "Hammasini tasdiqlash": biror ochiq amal tayyor bo'lmasa — hech biri yozilmaydi; aks holda har biri o'z kaliti bilan. */
export function applyGroup(sql: Sql, actor: Actor, g: string, now: string, run: (op: string, args: unknown, key: string) => RpcResult): GroupApply {
  const rows = groupDrafts(sql, actor, g, now)
  const open = rows.map((r, index) => ({ index, r })).filter((x) => isOpen(x.r))
  const notReady = open.filter((x) => !x.r.draft.ready).map((x) => ({ index: x.index, draft: x.r.draft }))
  if (notReady.length) return { ok: false, notReady, rows }
  const results = open.map(({ r }) => {
    const out = applyDraft(sql, actor, r.draft.id, null, now, run)
    return { id: r.draft.id, error: out.ok ? null : { code: out.error.code, params: out.error.params ?? {} } }
  })
  return { ok: true, results, rows: groupDrafts(sql, actor, g, now) }
}

/** Guruhning ochiq amallarini bekor qilish. */
export function cancelGroup(sql: Sql, actor: Actor, g: string, now: string): GroupRow[] {
  for (const r of groupDrafts(sql, actor, g, now)) if (isOpen(r)) markDraft(sql, r.draft, 'cancelled', null, now)
  return groupDrafts(sql, actor, g, now)
}

/** Kunlik AI chaqiruvlari hisobi (do'kon boshiga) — byudjetdan oshmaslik uchun. */
export function takeAiQuota(sql: Sql, limit: number, today: string): boolean {
  const day = sql.get<{ value: string }>("SELECT value FROM meta WHERE key = 'ai_day'")?.value
  const count = day === today ? Number(sql.get<{ value: string }>("SELECT value FROM meta WHERE key = 'ai_count'")?.value ?? '0') : 0
  if (count >= limit) return false
  sql.run("INSERT INTO meta(key, value) VALUES('ai_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", today)
  sql.run("INSERT INTO meta(key, value) VALUES('ai_count', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(count + 1))
  return true
}

export type ApplyOutcome = { ok: true; draft: Draft } | { ok: false; error: { code: string; params: Record<string, unknown>; status: number }; draft: Draft | null }

/** Qoralamani qo'llash: tayyor bo'lmasa — xato (muammolar bilan); bo'lsa — op dispatch orqali. */
export function applyDraft(
  sql: Sql, actor: Actor, id: string, edits: DraftEdits | null, now: string,
  run: (op: string, args: unknown, key: string) => RpcResult,
): ApplyOutcome {
  const loaded = loadDraft(sql, actor, id, now)
  if (!loaded) return { ok: false, error: { code: 'cloud.ai.errors.draftGone', params: {}, status: 404 }, draft: null }
  if (loaded.status === 'applied') return { ok: true, draft: loaded }
  if (loaded.status === 'cancelled') return { ok: false, error: { code: 'cloud.ai.errors.draftCancelled', params: {}, status: 409 }, draft: loaded }
  let d = edits ? applyEdits(sql, actor, loaded, edits) : loaded
  if (!d.ready) return { ok: false, error: { code: 'cloud.ai.errors.notReady', params: {}, status: 409 }, draft: d }
  // Yangi mijoz: avval yaratiladi (shu nomli bo'lsa — o'sha; kalit bilan idempotent), keyin asosiy yozuv.
  if (d.newCustomer && !d.customerId) {
    const same = sql.get<{ id: number }>('SELECT id FROM customers WHERE lower(trim(name)) = lower(?) AND is_active = 1 AND is_walk_in = 0 LIMIT 1', d.newCustomer)
    let cid = same?.id ?? null
    if (!cid) {
      const c = run('saveCustomer', [d.newCustomer, null], `ai_${d.id}_c`)
      if (!c.ok) return { ok: false, error: c.error, draft: d }
      cid = c.data as number
    }
    d = { ...d, customerId: cid, customerName: d.newCustomer, newCustomer: null }
  }
  const { op, args } = toOp(sql, actor, d)
  const r = run(op, args, `ai_${d.id}`)
  if (!r.ok) {
    sql.run('UPDATE assistant_drafts SET draft = ? WHERE id = ?', JSON.stringify(d), d.id)
    return { ok: false, error: r.error, draft: d }
  }
  return { ok: true, draft: markDraft(sql, d, 'applied', resultSummary(d, r.data), now) }
}
