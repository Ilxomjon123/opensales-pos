import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { doSql, type Sql } from './sql'
import { migrate } from './schema'
import { dispatch, memberRole, type Actor, type Ctx, type RpcResult } from './rpc'
import { DomainError } from './errors'
import { OPS } from './ops'
import { shopProgress, type ShopProgress } from './progress'
import { settingOf, weekSeries, type CardStats } from './cardStats'
import { aiEnabled, getMeta, initShop, isSubscriptionActive, readSubscription, setAiEnabled, setSubscription, syncMember, type MemberSync, type Subscription } from './init'
import { ownOpenShift } from './ops/shifts'
import { PUBLIC_SETTINGS } from './ops/settings'
import { applyDraft, applyEdits, applyGroup, cancelGroup, createDraft, fxSaved, groupDrafts, historyTurns, loadDraft, markDraft, shopHints, takeAiQuota, type ApplyOutcome, type Draft, type DraftEdits, type GroupApply, type GroupRow, type Source, type VoiceMeta } from './assistant'
import { chatEntries, deleteChat, listChats, openChat, pruneChats, touchChat, type ChatEntry, type ChatRow } from './chats'
import type { Extraction, ShopHints, Turn } from '../assistant/ai'
import { bumpAttempt, describeLines, getTransfer, listTransfers, pendingOut, planTransferIn, transferDone, transferIn, transferOut, type PlanLine, type TransferInput, type TransferLine, type TransferRow } from './transfers'
import { applyCatalog, catalogChanges, catalogSource, catalogVersion, imagesPage, putImages, type CatalogChanges, type ImageRow } from './catalogSync'

// Bitta do'kon = bitta Durable Object (o'z SQLite bazasi). So'rovlar shu obyekt ichida
// ketma-ket bajariladi — ikki kassir bir vaqtda sotsa ham qoldiq/chek raqami poygasi yo'q.
// Barcha op'lar sinxron (ichida await yo'q) — input gate boshqa so'rovni orasiga qo'ymaydi.

const IDEMPOTENCY_KEEP_DAYS = 7
const DAY_MS = 86400_000

export class ShopDO extends DurableObject<Env> {
  private readonly sql: Sql

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = doSql(ctx.storage)
    // Faqat sxema — har so'rovda emas, obyekt uyg'onganda bir marta.
    ctx.blockConcurrencyWhile(async () => { migrate(this.sql) })
  }

  private tenantId(): string {
    return getMeta(this.sql, 'tenant_id') ?? ''
  }

  private imageUrl = (pid: number, ver: string) => `/img/${this.tenantId()}/${pid}/${ver}`

  async rpc(op: string, args: unknown, actor: Actor, idempotencyKey: string | null): Promise<RpcResult> {
    const now = new Date().toISOString()
    return dispatch(this.sql, OPS, op, args, actor, {
      idempotencyKey,
      subscriptionActive: isSubscriptionActive(readSubscription(this.sql), now),
      imageUrl: this.imageUrl,
    })
  }

  /** Platforma admini ko'rish rejimi: faqat o'qish op'lari (dispatch `viewOnly` yozuvchini rad etadi). */
  async viewRpc(op: string, args: unknown, actor: Actor): Promise<RpcResult> {
    return dispatch(this.sql, OPS, op, args, actor, { subscriptionActive: true, imageUrl: this.imageUrl, viewOnly: true })
  }

  // ---- AI yordamchisi (assistant.ts). AI chaqiruvi Worker'da; bu yerda — tekshiruv, qoralama, qo'llash.

  private actorOf(a: Actor): Actor | null {
    const role = memberRole(this.sql, a.uid)
    return role ? { ...a, role } : null
  }

  /** AI chaqirishdan OLDIN: a'zo faol, obuna ochiq, kunlik limit bor → do'kon lug'ati. */
  async assistantBegin(actor: Actor, dailyLimit: number, chatId: string | null = null): Promise<{ ok: true; hints: ShopHints; history: Turn[] } | { ok: false; code: string; status: number }> {
    const a = this.actorOf(actor)
    if (!a) return { ok: false, code: 'cloud.errors.memberRevoked', status: 403 }
    const now = new Date().toISOString()
    if (!isSubscriptionActive(readSubscription(this.sql), now)) return { ok: false, code: 'cloud.errors.subscriptionExpired', status: 402 }
    // Admin o'chirgan — AI chaqirilmaydi (kvota ham sarflanmaydi).
    if (!aiEnabled(this.sql)) return { ok: false, code: 'cloud.ai.errors.disabled', status: 403 }
    if (!takeAiQuota(this.sql, dailyLimit, now.slice(0, 10))) return { ok: false, code: 'cloud.ai.errors.quota', status: 429 }
    // Chat konteksti faqat egasiga: begona/noto'g'ri id — bo'sh tarix (yangi chat ochiladi).
    const own = chatId && this.sql.get('SELECT 1 FROM assistant_chats WHERE id = ? AND uid = ?', chatId, a.uid) ? chatId : null
    // Bugun (oxirgi 12 soat) shu chatda — bot bo'lsa bot xabarlarida — gaplashilganmi: qayta salomlashilmaydi.
    const since = new Date(Date.now() - 12 * 3600_000).toISOString()
    const greeted = own
      ? !!this.sql.get('SELECT 1 FROM assistant_drafts WHERE uid = ? AND chat_id = ? AND created_at >= ? LIMIT 1', a.uid, own, since)
      : chatId === null && !!this.sql.get('SELECT 1 FROM assistant_drafts WHERE uid = ? AND chat_id IS NULL AND created_at >= ? LIMIT 1', a.uid, since)
    return { ok: true, hints: { ...shopHints(this.sql), greeted }, history: own ? historyTurns(this.sql, a.uid, now, own) : chatId !== null ? [] : historyTurns(this.sql, a.uid, now) }
  }

  /**
   * AI natijasi → qoralama(lar). Xabarda bir nechta amal bo'lsa (`extraction.also`) — har biriga alohida qoralama
   * (`partOf` = birinchisining id'si), hammasi bitta tx'da; javobda birinchisi + `more`.
   */
  async assistantDraft(actor: Actor, transcript: string, source: Source, extraction: Extraction, chat: { id: string | null; voice: VoiceMeta | null } | null = null, lang: 'uz' | 'ru' = 'uz'): Promise<(Draft & { more: Draft[] }) | null> {
    const a = this.actorOf(actor)
    if (!a) return null
    const now = new Date().toISOString()
    const rest = extraction.also ?? []
    return this.sql.tx(() => {
      // Ilova chati: ochiladi/yaratiladi, qoralama shu chatga yoziladi, sarlavha va faollik yangilanadi.
      const chatId = chat ? openChat(this.sql, a.uid, chat.id, now) : null
      const base = { transcript, source, now, lang, ...(chatId ? { chatId } : {}) }
      const d = createDraft(this.sql, a, { ...base, extraction, voice: chat?.voice ?? null })
      const more = rest.map((x) => createDraft(this.sql, a, { ...base, extraction: x, partOf: d.id }))
      if (chatId) touchChat(this.sql, chatId, transcript, now)
      const tag = chatId ? { chatId } : {}
      return { ...d, ...tag, more: more.map((m) => ({ ...m, ...tag })) }
    })
  }

  async assistantChats(actor: Actor): Promise<ChatRow[] | null> {
    const a = this.actorOf(actor)
    return a ? listChats(this.sql, a.uid) : null
  }

  async assistantChat(actor: Actor, chatId: string): Promise<ChatEntry[] | null> {
    const a = this.actorOf(actor)
    return a ? chatEntries(this.sql, a, chatId, new Date().toISOString()) : null
  }

  async assistantChatDelete(actor: Actor, chatId: string): Promise<boolean> {
    const a = this.actorOf(actor)
    return a ? deleteChat(this.sql, a.uid, chatId) : false
  }

  async assistantGet(actor: Actor, id: string): Promise<Draft | null> {
    const a = this.actorOf(actor)
    return a ? loadDraft(this.sql, a, id, new Date().toISOString()) : null
  }

  /** Foydalanuvchi tuzatishi (tovar tanlash, miqdor, mijoz) — saqlanadi, holat qayta hisoblanadi. */
  async assistantUpdate(actor: Actor, id: string, edits: DraftEdits): Promise<Draft | null> {
    const a = this.actorOf(actor)
    if (!a) return null
    const d = loadDraft(this.sql, a, id, new Date().toISOString())
    if (!d || d.status !== 'new') return d
    const next = applyEdits(this.sql, a, d, edits)
    this.sql.run('UPDATE assistant_drafts SET draft = ? WHERE id = ?', JSON.stringify(next), id)
    return next
  }

  async assistantApply(actor: Actor, id: string, edits: DraftEdits | null): Promise<ApplyOutcome> {
    const a = this.actorOf(actor)
    if (!a) return { ok: false, error: { code: 'cloud.errors.memberRevoked', params: {}, status: 403 }, draft: null }
    const now = new Date().toISOString()
    return applyDraft(this.sql, a, id, edits, now, (op, args, key) => dispatch(this.sql, OPS, op, args, a, {
      idempotencyKey: key,
      subscriptionActive: isSubscriptionActive(readSubscription(this.sql), now),
      imageUrl: this.imageUrl,
    }))
  }

  /** Bot kartasi (chat, xabar) — qoralama keyinroq tuzatilsa eski kartani "yangilandi" qilish uchun. `widget` — guruh widget kartasi. */
  async assistantSetCard(actor: Actor, id: string, chat: number, msg: number, widget = false): Promise<void> {
    const a = this.actorOf(actor)
    if (!a || !/^[a-f0-9]{16}$/.test(id)) return
    const r = this.sql.get<{ uid: number; draft: string }>('SELECT uid, draft FROM assistant_drafts WHERE id = ?', id)
    if (!r || r.uid !== a.uid) return
    const d = JSON.parse(r.draft) as Draft
    this.sql.run('UPDATE assistant_drafts SET draft = ? WHERE id = ?', JSON.stringify({ ...d, card: widget ? { chat, msg, w: 1 } : { chat, msg } }), id)
  }

  // ---- Bot widget kartasi: bitta xabarning hamma amallari (guruh, shop/assistant.ts groupDrafts) ----

  async assistantGroup(actor: Actor, g: string): Promise<GroupRow[] | null> {
    const a = this.actorOf(actor)
    return a ? groupDrafts(this.sql, a, g, new Date().toISOString()) : null
  }

  async assistantApplyGroup(actor: Actor, g: string): Promise<GroupApply | null> {
    const a = this.actorOf(actor)
    if (!a) return null
    const now = new Date().toISOString()
    return applyGroup(this.sql, a, g, now, (op, args, key) => dispatch(this.sql, OPS, op, args, a, {
      idempotencyKey: key,
      subscriptionActive: isSubscriptionActive(readSubscription(this.sql), now),
      imageUrl: this.imageUrl,
    }))
  }

  async assistantCancelGroup(actor: Actor, g: string): Promise<GroupRow[] | null> {
    const a = this.actorOf(actor)
    return a ? cancelGroup(this.sql, a, g, new Date().toISOString()) : null
  }

  async fxSaved(from: string, to: string): Promise<number | null> {
    return fxSaved(this.sql, from, to)
  }

  async assistantCancel(actor: Actor, id: string): Promise<Draft | null> {
    const a = this.actorOf(actor)
    if (!a) return null
    const d = loadDraft(this.sql, a, id, new Date().toISOString())
    if (!d || d.status !== 'new') return d
    return markDraft(this.sql, d, 'cancelled', null, new Date().toISOString())
  }

  /** Onboarding / yangi do'kon. Takror chaqirilsa zarar yo'q. `catalogOf` — filial (katalog manbai). */
  async init(p: { tenantId: string; shopName: string; owner: { uid: number; name: string }; subscription: Subscription; catalogOf?: string | null }): Promise<void> {
    initShop(this.sql, p, new Date().toISOString())
    // Bulut (2026-11-10, varonka): qoldiqsiz sotish standart YOQIQ — yangi tovar qoldig'i 0 bo'ladi va kassa uni
    // yashirardi ("Mahsulot topilmadi" → odam ketardi). Ega o'chirsa — saqlanadi (IGNORE). initShop (desktop
    // paritet testlari) o'zgarmaydi.
    this.sql.run("INSERT OR IGNORE INTO settings(key, value) VALUES('allow_negative_stock', '1')")
    await this.ensureAlarm()
  }

  // ---- Bir nechta do'kon: katalog sinxroni (catalogSync.ts) ----

  /** Asosiy do'kon: kursordan keyingi o'zgarishlar. `withCost` — yangi alohida do'konga nusxa. */
  async catalogChanges(cursor: number, limit?: number, withCost = false): Promise<CatalogChanges> {
    return catalogChanges(this.sql, cursor, limit, withCost)
  }

  /** Filial / nusxa: holat (manba, kursor, o'z versiyasi). */
  async catalogState(): Promise<{ catalogOf: string | null; cursor: number; version: number }> {
    return { catalogOf: catalogSource(this.sql), cursor: Number(getMeta(this.sql, 'catalog_cursor') ?? 0), version: catalogVersion(this.sql) }
  }

  async applyCatalog(ch: CatalogChanges, from: number): Promise<{ applied: boolean; cursor: number }> {
    return applyCatalog(this.sql, ch, from)
  }

  async imagesPage(afterId: number, limit?: number): Promise<ImageRow[]> {
    return imagesPage(this.sql, afterId, limit)
  }

  async putImages(rows: ImageRow[]): Promise<void> {
    putImages(this.sql, rows, new Date().toISOString())
  }

  // ---- Do'konlararo ko'chirish (transfers.ts). Orkestratsiya Worker'da; bu yerda — tekshiruv va yozuv. ----

  /** Ega (faol) va obuna ochiq — ko'chirish yozuvlari uchun. */
  private ownerCtx(actor: Actor): Ctx {
    const role = memberRole(this.sql, actor.uid)
    if (role !== 'owner') throw new DomainError('cloud.errors.forbidden', {}, 403)
    const now = new Date().toISOString()
    if (!isSubscriptionActive(readSubscription(this.sql), now)) throw new DomainError('cloud.errors.subscriptionExpired', {}, 402)
    return {
      sql: this.sql, actor: { ...actor, role }, now: () => now, imageUrl: this.imageUrl,
      setting: (key, fallback = '') => this.sql.get<{ value: string | null }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback,
    }
  }

  private guard<T>(fn: () => T): { ok: true; data: T } | { ok: false; error: { code: string; params: Record<string, unknown>; status: number } } {
    try { return { ok: true, data: fn() } } catch (e) {
      if (e instanceof DomainError) return { ok: false, error: { code: e.code, params: e.params, status: e.status } }
      throw e
    }
  }

  private shopName(): string {
    return this.sql.get<{ value: string }>("SELECT value FROM settings WHERE key = 'shop_name'")?.value ?? ''
  }

  /** Manba: satrlar ma'lumoti (qabul do'koni moslashi uchun). */
  async transferDescribe(actor: Actor, input: TransferInput[]) {
    return this.guard(() => { this.ownerCtx(actor); return describeLines(this.sql, input) })
  }

  /** Qabul: moslash rejasi (o'zgartirmaydi). */
  async transferPlan(actor: Actor, lines: PlanLine[], shared: boolean) {
    return this.guard(() => { this.ownerCtx(actor); return planTransferIn(this.sql, lines, shared) })
  }

  async transferOut(actor: Actor, p: { id: string; peer: string; peerName: string; input: TransferInput[]; targets: { targetProductId: number | null }[]; note: string | null }) {
    const r = this.guard(() => {
      const ctx = this.ownerCtx(actor)
      return transferOut(this.sql, { ...p, actor: ctx.actor, now: ctx.now(), allowNegative: ctx.setting('allow_negative_stock', '0') === '1' })
    })
    // Qabul tomoni yiqilsa — alarm qayta yuboradi.
    if (r.ok && r.data.status === 'pending') await this.retrySoon()
    return r
  }

  async transferIn(actor: Actor, p: { id: string; peer: string; peerName: string; lines: TransferLine[]; note: string | null }) {
    return this.guard(() => transferIn(this.ownerCtx(actor), p))
  }

  async transferDone(id: string): Promise<void> {
    transferDone(this.sql, id, new Date().toISOString())
  }

  async transfers(actor: Actor): Promise<TransferRow[] | null> {
    return memberRole(this.sql, actor.uid) === 'owner' ? listTransfers(this.sql) : null
  }

  async transfer(id: string): Promise<TransferRow | null> {
    return getTransfer(this.sql, id)
  }

  private async retrySoon() {
    const at = await this.ctx.storage.getAlarm()
    const soon = Date.now() + 60_000
    if (at === null || at > soon) await this.ctx.storage.setAlarm(soon)
  }

  /** Kutilayotgan ko'chirishlarni qabul do'koniga qayta yuborish (alarm). Qolganlari soni. */
  private async retryTransfers(): Promise<number> {
    let left = 0
    const from = this.tenantId()
    for (const t of pendingOut(this.sql)) {
      bumpAttempt(this.sql, t.id)
      const actor: Actor = { uid: t.user_id ?? 0, role: 'owner', name: t.user_name ?? '' }
      try {
        const r = await this.env.SHOP.get(this.env.SHOP.idFromName(t.peer_tenant), { locationHint: 'eeur' })
          .transferIn(actor, { id: t.id, peer: from, peerName: this.shopName(), lines: t.items, note: t.note })
        if (r.ok) { transferDone(this.sql, t.id, new Date().toISOString()); continue }
      } catch (e) { console.error('transfer retry', t.id, e) }
      left++
    }
    return left
  }

  async syncMember(m: MemberSync): Promise<void> {
    syncMember(this.sql, m, new Date().toISOString())
  }

  async setSubscription(s: Subscription): Promise<void> {
    setSubscription(this.sql, s)
  }

  async setAiEnabled(on: boolean): Promise<void> {
    setAiEnabled(this.sql, on)
  }

  /** Kirishdan keyin klientga bitta javobda: rol, obuna, ochiq sozlamalar, ochiq smena. */
  async bootstrap(actor: Actor) {
    const now = new Date().toISOString()
    const sub = readSubscription(this.sql)
    const m = this.sql.get<{ role: string; active: number }>('SELECT role, active FROM members WHERE uid = ?', actor.uid)
    const settings: Record<string, string> = {}
    for (const k of PUBLIC_SETTINGS) {
      const v = this.sql.get<{ value: string | null }>('SELECT value FROM settings WHERE key = ?', k)?.value
      if (v != null) settings[k] = v
    }
    return {
      member: m && m.active ? { role: m.role, active: true } : null,
      subscription: sub ? { ...sub, active: isSubscriptionActive(sub, now) } : null,
      settings,
      shift: m && m.active ? ownOpenShift({ sql: this.sql, actor, now: () => now, setting: () => '', imageUrl: this.imageUrl }) : null,
      progress: shopProgress(this.sql),
    }
  }

  /**
   * Bot "Savdo" kartasi (telegram/salesCard.ts): davr [from, to] (UTC kun) + oxirgi 7 kun. Faqat faol EGA
   * (rol D1'dan emas, shu DO'dagi members nusxasidan — op'lar kabi); aks holda null.
   */
  async salesCard(actor: Actor, from: string, to: string, today: string): Promise<CardStats | null> {
    const a = this.actorOf(actor)
    if (!a || a.role !== 'owner') return null
    const sum = await this.rpc('businessSummary', [from, to], a, null)
    const rep = await this.rpc('reportSummary', [from, to], a, null)
    if (!sum.ok || !rep.ok) return null
    const p = sum.data as Record<string, number>
    const top = (rep.data as { topProducts: { name: string; total: number }[] }).topProducts.slice(0, 3)
    return {
      shop: this.shopName(),
      currency: settingOf(this.sql, 'currency_symbol', "so'm"),
      total: p.total, count: p.count, profit: p.profit, cash: p.cash, card: p.card, debt: p.debt, returns: p.returns,
      expenses: p.expenses, receivable: p.receivable, debtors: p.debtors,
      week: weekSeries(this.sql, today),
      top: top.map((x) => ({ name: x.name, total: x.total })),
    }
  }

  /** Varonka (cron, admin paneli): faqat o'qish. */
  async progress(): Promise<ShopProgress> {
    return shopProgress(this.sql)
  }

  /**
   * Asoschi yozishmasi: odam BOT chatiga (ilova chati emas) `since` dan keyin yozgan/aytgan matnlari — AI'ga ketib
   * asoschiga yetmagan javoblarni tiklash uchun (`/tg/replies`, faqat setup kaliti bilan, faqat outreach olganlar).
   */
  async botTranscripts(uid: number, since: string): Promise<{ transcript: string; kind: string; created_at: string }[]> {
    return this.sql.all<{ transcript: string; kind: string; created_at: string }>(
      'SELECT transcript, kind, created_at FROM assistant_drafts WHERE uid = ? AND chat_id IS NULL AND created_at >= ? ORDER BY created_at LIMIT 50', uid, since)
  }

  /** Chek rasmi (JPEG) — ulashish uchun; id tasodifiy 128 bit (manzilni taxmin qilib bo'lmaydi). */
  async putReceiptImage(id: string, data: Uint8Array): Promise<void> {
    this.sql.run('INSERT OR REPLACE INTO receipt_images(id, data, created_at) VALUES(?, ?, ?)', id, data, new Date().toISOString())
  }

  async getReceiptImage(id: string): Promise<ArrayBuffer | null> {
    return this.sql.get<{ data: ArrayBuffer }>('SELECT data FROM receipt_images WHERE id = ?', id)?.data ?? null
  }

  async getImage(productId: number, version: string): Promise<{ mime: string; data: ArrayBuffer } | null> {
    const r = this.sql.get<{ mime: string; data: ArrayBuffer }>(
      'SELECT mime, data FROM product_images WHERE product_id = ? AND version = ?', productId, version,
    )
    return r ?? null
  }

  private async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
  }

  /** Kunlik tozalash (eski idempotency kalitlari — javoblar 7 kun) + kutilayotgan ko'chirishlarni qayta yuborish. */
  async alarm(): Promise<void> {
    const pending = await this.retryTransfers()
    const due = Number(getMeta(this.sql, 'cleanup_due') ?? 0)
    if (Date.now() < due) {
      await this.ctx.storage.setAlarm(pending ? Date.now() + 5 * 60_000 : due)
      return
    }
    const cutoff = new Date(Date.now() - IDEMPOTENCY_KEEP_DAYS * DAY_MS).toISOString()
    this.sql.run('DELETE FROM idempotency WHERE created_at < ?', cutoff)
    // Qoralamalar 7 kun (audit uchun yetarli; tasdiqlangan yozuvning o'zi asosiy jadvallarda). Ilova chatidagilar —
    // chat bilan birga (90 kun faolsiz bo'lsa o'chadi), tarix ko'rinib tursin.
    this.sql.run('DELETE FROM assistant_drafts WHERE created_at < ? AND chat_id IS NULL', cutoff)
    pruneChats(this.sql, Date.now())
    this.sql.run('DELETE FROM receipt_images WHERE created_at < ?', new Date(Date.now() - 2 * DAY_MS).toISOString())
    const next = Date.now() + DAY_MS
    this.sql.run("INSERT INTO meta(key, value) VALUES('cleanup_due', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(next))
    await this.ctx.storage.setAlarm(pending ? Date.now() + 5 * 60_000 : next)
  }
}
