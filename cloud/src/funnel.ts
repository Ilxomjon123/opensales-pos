import type { Env } from './env'
import { escapeHtml, tgCall, webAppButton } from './telegram/api'
import { shopStub } from './catalog'
import { isAdminUid } from './registry'
import type { ShopProgress } from './shop/progress'

// Varonka (2026-11-10): reklama → bot/ilova → do'kon → tovar → sotuv → keyingi kunda yana sotuv.
//
// Bosqichlar `funnel_users` da (bitta qator = bitta odam, har bosqich — birinchi yetgan vaqt). Kirish/do'kon
// bosqichlari so'rov yo'lida yoziladi (xato kirishni BUZMAYDI — faqat log). Tovar/sotuv bosqichlari do'kon
// DO'sidan (`progress`) cron (har 15 daqiqa) va admin paneli orqali olinadi — sotuv yo'liga hech narsa qo'shilmaydi.
//
// Eslatmalar (admin yoqadi, standart O'CHIQ): (uid, kind) bo'yicha ko'pi bilan bitta — `nudges` ga yuborishdan
// OLDIN yoziladi (at-most-once: timeout'dan keyin qayta yuborilmaydi). Faqat Toshkent 9:00–21:00 da.

/** `pm` — bot shu odamga yoza oladi (initData `allows_write_to_pm` yoki /start). */
export type Who = { uid: number; name: string; username: string | null; lang: string | null; pm?: boolean }
type Db = D1Database

const SRC_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Reklama manbai: bot /start parametri yoki startapp. Taklif (inv_) manba emas. */
export function cleanSrc(x: unknown): string | null {
  return typeof x === 'string' && SRC_RE.test(x) && !x.startsWith('inv_') ? x : null
}

const langOf = (code: string | null | undefined): 'uz' | 'ru' => (code === 'ru' ? 'ru' : 'uz')

async function touch(db: Db, w: Who, col: 'started_at' | 'opened_at', src: string | null, now: string): Promise<void> {
  // `col` — faqat yuqoridagi ikki nomdan biri (SQL'ga foydalanuvchi matni tushmaydi).
  const pm = w.pm ? now : null
  await db.prepare(
    `INSERT INTO funnel_users (uid, name, username, lang, src, ${col}, pm_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET name = excluded.name, username = excluded.username,
       lang = COALESCE(excluded.lang, funnel_users.lang), src = COALESCE(funnel_users.src, excluded.src),
       ${col} = COALESCE(funnel_users.${col}, excluded.${col}), pm_at = COALESCE(funnel_users.pm_at, excluded.pm_at)`,
  ).bind(w.uid, w.name, w.username, w.lang, src, now, pm, now).run()
}

/** Botda /start (taklifsiz) — endi bot unga yoza oladi. */
export function trackStart(db: Db, w: Who, src: string | null, now: string) { return touch(db, { ...w, pm: true }, 'started_at', src, now) }
/** Ilova ochildi (yangi odam yoki ega; kassirlar varonkaga kirmaydi). */
export function trackOpen(db: Db, w: Who, src: string | null, now: string) { return touch(db, w, 'opened_at', src, now) }

/** Birinchi (ildiz) do'kon ochildi. */
export async function trackShop(db: Db, w: Who, shopId: string, now: string): Promise<void> {
  await db.prepare(
    `INSERT INTO funnel_users (uid, name, username, lang, shop_id, shop_at, pm_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET shop_id = COALESCE(funnel_users.shop_id, excluded.shop_id),
       shop_at = COALESCE(funnel_users.shop_at, excluded.shop_at), lang = COALESCE(funnel_users.lang, excluded.lang),
       pm_at = COALESCE(funnel_users.pm_at, excluded.pm_at)`,
  ).bind(w.uid, w.name, w.username, w.lang, shopId, now, w.pm ? now : null, now).run()
}

/** Bot shu odamga yoza oladimi (varonka qatoridan; qator bo'lmasa — false). */
export async function canMessage(db: Db, uid: number): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM funnel_users WHERE uid = ? AND pm_at IS NOT NULL').bind(uid).first())
}

/**
 * Ilovada "xabar yozishga ruxsat" berildi. Faqat mavjud varonka qatorini yangilaydi (kassirlar varonkaga
 * kirmaydi). Bu klientning so'zi — tekshirib bo'lmaydi, lekin faqat shu odamning o'z qatoriga ta'sir qiladi.
 */
export async function markWriteAccess(db: Db, uid: number, now: string): Promise<void> {
  await db.prepare('UPDATE funnel_users SET pm_at = COALESCE(pm_at, ?) WHERE uid = ?').bind(now, uid).run()
}

/** Telegram aniq "bu odamga yozib bo'lmaydi" dedi — qayta ruxsat bermaguncha eslatma yuborilmaydi. */
const UNREACHABLE = /chat not found|bot was blocked by the user|user is deactivated|bot can't initiate conversation/i
export async function markUnreachable(db: Db, uid: number, description: string | undefined): Promise<void> {
  if (description && UNREACHABLE.test(description)) await db.prepare('UPDATE funnel_users SET pm_at = NULL WHERE uid = ?').bind(uid).run()
}

/** Kirish yo'lidagi yozuv — xato bo'lsa ham asosiy javob buzilmaydi. */
export function quietly(p: Promise<unknown>, what: string): Promise<void> {
  return p.then(() => undefined, (e) => console.error(`funnel ${what}:`, e instanceof Error ? e.message : e))
}

// ---- Tovar/sotuv bosqichlari (DO'dan) ---------------------------------------------------------

async function applyProgress(db: Db, uid: number, p: ShopProgress, now: string): Promise<void> {
  await db.prepare(
    `UPDATE funnel_users SET products = ?, sales = ?, last_sale_at = ?, checked_at = ?,
       product_at = COALESCE(product_at, CASE WHEN ? > 0 THEN ? END),
       sale_at = COALESCE(sale_at, ?), day2_at = COALESCE(day2_at, ?)
     WHERE uid = ?`,
  ).bind(p.products, p.sales, p.lastSaleAt, now, p.products, now, p.firstSaleAt, p.day2At, uid).run()
}

/** Bir nechta qatorni DO'lardan yangilaydi (bir vaqtda ko'pi bilan 10 ta; bittasi yiqilsa qolganlari davom etadi). */
export async function refreshProgress(env: Env, rows: { uid: number; shop_id: string }[], now: string): Promise<void> {
  for (let i = 0; i < rows.length; i += 10) {
    await Promise.all(rows.slice(i, i + 10).map(async (r) => {
      try { await applyProgress(env.DB, r.uid, await shopStub(env, r.shop_id).progress(), now) }
      catch (e) { console.error('funnel progress', r.shop_id.slice(0, 8), e instanceof Error ? e.message : e) }
    }))
  }
}

// ---- Eslatmalar ---------------------------------------------------------------------------------

export type NudgeKind = 'no_shop' | 'no_product' | 'no_sale' | 'trial_end'
type Cand = { uid: number; kind: NudgeKind; lang: string | null; shop: string | null; products: number; until: string | null }

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

/** Matnlar (uz/ru). Tugma mini app'ni kerakli bo'limda ochadi. 2026-11-10: user varonka sifatida tasdiqladi. */
export const NUDGE_TEXT: Record<NudgeKind, Record<'uz' | 'ru', { text: string; button: string; path: string }>> = {
  no_shop: {
    uz: { text: "Kassani ishga tushirishga 1 daqiqa qoldi: do'kon nomini yozing — tamom. Sotuvni ovoz bilan ham kiritasiz: «Alisher akaga 2 ta non, qarzga».\n\n{days} kun bepul.", button: '🧾 Kassani ochish', path: '' },
    ru: { text: 'До запуска кассы — 1 минута: введите название магазина, и всё. Продажи можно вводить даже голосом: «Алишеру 2 хлеба, в долг».\n\n{days} дней бесплатно.', button: '🧾 Открыть кассу', path: '' },
  },
  no_product: {
    uz: { text: "<b>{shop}</b> ochildi — endi tovar qo'shing. Eng tezi ovoz bilan: kassada ✨ tugmasini bosib ayting: «Yangi tovar: Coca-Cola 1 litr, narxi 12 000». Yoki «Mahsulotlar» bo'limida qo'lda.", button: "➕ Tovar qo'shish", path: 'products?new=1' },
    ru: { text: 'Магазин <b>{shop}</b> открыт — добавьте товары. Быстрее всего голосом: нажмите ✨ в кассе и скажите: «Новый товар: Coca-Cola 1 литр, цена 12 000». Или вручную в разделе «Товары».', button: '➕ Добавить товар', path: 'products?new=1' },
  },
  no_sale: {
    uz: { text: "Tovarlar tayyor ({products} ta). Birinchi sotuvni qiling: kassada tovarni bosing → «Savat» → naqd summani tanlang → «Sotuvni yakunlash». Chekni mijozga Telegramda yuborasiz, qarzga sotsangiz o'zi yoziladi.", button: '🧾 Kassani ochish', path: 'pos' },
    ru: { text: 'Товары готовы ({products} шт.). Сделайте первую продажу: в кассе нажмите на товар → «Корзина» → выберите сумму наличных → «Завершить продажу». Чек отправите клиенту в Telegram, долг запишется сам.', button: '🧾 Открыть кассу', path: 'pos' },
  },
  trial_end: {
    uz: { text: "<b>{shop}</b>: bepul sinov {date} da tugaydi. Davom ettirish uchun yozing: @{support} — narx va to'lovni aytamiz. Ma'lumotlaringiz saqlanadi.", button: '🧾 Kassani ochish', path: '' },
    ru: { text: '<b>{shop}</b>: бесплатный период заканчивается {date}. Чтобы продолжить, напишите @{support} — расскажем о цене и оплате. Ваши данные сохранятся.', button: '🧾 Открыть кассу', path: '' },
  },
}

export function nudgeMessage(env: Env, c: Cand, trialDays: number) {
  const l = langOf(c.lang)
  const t = NUDGE_TEXT[c.kind][l]
  const day = c.until ? new Date(Date.parse(c.until) + 5 * HOUR).toISOString().slice(0, 10) : ''
  const text = t.text
    .replace('{shop}', escapeHtml(c.shop ?? ''))
    .replace('{products}', String(c.products))
    .replace('{days}', String(trialDays))
    .replace('{date}', day ? `${day.slice(8, 10)}.${day.slice(5, 7)}` : '')
    .replace('{support}', escapeHtml(env.SUPPORT_USERNAME ?? ''))
  return { text, reply_markup: webAppButton(t.button, env.APP_URL.replace(/\/+$/, '') + '/' + t.path) }
}

export async function nudgesEnabled(db: Db): Promise<boolean> {
  const r = await db.prepare("SELECT value FROM platform_settings WHERE key = 'nudges'").first<{ value: string }>()
  return r?.value === '1'
}
export async function setNudgesEnabled(db: Db, on: boolean): Promise<void> {
  await db.prepare("INSERT INTO platform_settings (key, value) VALUES ('nudges', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(on ? '1' : '0').run()
}

/** Toshkent vaqti 9:00–21:00 — tunda yozilmaydi (keyingi cron ertalab yuboradi). */
export function inSendWindow(now: Date): boolean {
  const h = new Date(now.getTime() + 5 * HOUR).getUTCHours()
  return h >= 9 && h < 21
}

/** Hozir eslatma olishi kerak bo'lganlar (har odamga bir martada bittadan; faqat bot yoza oladiganlar — `pm_at`). */
export async function nudgeCandidates(env: Env, now: Date): Promise<Cand[]> {
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const nowIso = now.toISOString()
  const notSent = (kind: NudgeKind) => `NOT EXISTS (SELECT 1 FROM nudges n WHERE n.uid = f.uid AND n.kind = '${kind}')`
  const q = async (kind: NudgeKind, sql: string, ...binds: (string | number)[]) =>
    (await env.DB.prepare(sql).bind(...binds).all<Omit<Cand, 'kind'>>()).results.map((r) => ({ ...r, kind }))
  const out: Cand[] = [
    // Kirdi, lekin do'kon ochmadi (va hech qaysi do'konda a'zo emas — kassirlar emas).
    ...await q('no_shop', `SELECT f.uid, f.lang, NULL shop, 0 products, NULL until FROM funnel_users f
      WHERE f.shop_id IS NULL AND f.pm_at IS NOT NULL AND min(COALESCE(f.started_at, f.opened_at), COALESCE(f.opened_at, f.started_at)) BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM members m WHERE m.uid = f.uid) AND ${notSent('no_shop')}`, at(3 * DAY), at(30 * MIN)),
    // Do'kon ochdi, 3 soatda tovar yo'q (hisob yangi — oxirgi 20 daqiqada tekshirilgan).
    ...await q('no_product', `SELECT f.uid, f.lang, t.name shop, f.products, NULL until FROM funnel_users f JOIN tenants t ON t.id = f.shop_id
      WHERE t.status = 'active' AND f.pm_at IS NOT NULL AND f.product_at IS NULL AND f.products = 0 AND f.checked_at >= ?
        AND f.shop_at BETWEEN ? AND ? AND ${notSent('no_product')}`, at(20 * MIN), at(7 * DAY), at(3 * HOUR)),
    // Tovar bor, sutkada sotuv yo'q.
    ...await q('no_sale', `SELECT f.uid, f.lang, t.name shop, f.products, NULL until FROM funnel_users f JOIN tenants t ON t.id = f.shop_id
      WHERE t.status = 'active' AND f.pm_at IS NOT NULL AND f.product_at IS NOT NULL AND f.sale_at IS NULL AND f.sales = 0 AND f.checked_at >= ?
        AND f.shop_at BETWEEN ? AND ? AND ${notSent('no_sale')}`, at(20 * MIN), at(10 * DAY), at(DAY)),
  ]
  // Sinov tugashiga ≤2 kun (to'lanmagan). Aloqa manzili bo'lmasa — yuborilmaydi (kimga yozishni aytolmaymiz).
  if (env.SUPPORT_USERNAME) {
    out.push(...await q('trial_end', `SELECT f.uid, f.lang, t.name shop, f.products, t.trial_until until FROM funnel_users f JOIN tenants t ON t.id = f.shop_id
      WHERE t.status = 'active' AND f.pm_at IS NOT NULL AND (t.paid_until IS NULL OR t.paid_until <= t.trial_until)
        AND t.trial_until > ? AND t.trial_until <= ? AND ${notSent('trial_end')}`, nowIso, new Date(now.getTime() + 2 * DAY).toISOString()))
  }
  const seen = new Set<number>()
  return out.filter((c) => !isAdminUid(env.ADMIN_CHAT_ID, c.uid) && !seen.has(c.uid) && seen.add(c.uid))
}

/** Eslatmalarni yuboradi. Qaytaradi: yuborildi / yiqildi soni. */
export async function sendNudges(env: Env, now: Date, trialDays: number, limit = 25): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0
  for (const c of (await nudgeCandidates(env, now)).slice(0, limit)) {
    // Avval yozuv (pending) — bir vaqtda ikkita cron bo'lsa ham bittasi yuboradi; timeout'dan keyin qayta yuborilmaydi.
    const ins = await env.DB.prepare("INSERT INTO nudges (uid, kind, status, at) VALUES (?, ?, 'pending', ?) ON CONFLICT(uid, kind) DO NOTHING")
      .bind(c.uid, c.kind, now.toISOString()).run()
    if (!ins.meta.changes) continue
    const r = await tgCall(env, 'sendMessage', { chat_id: c.uid, parse_mode: 'HTML', disable_web_page_preview: true, ...nudgeMessage(env, c, trialDays) })
    await env.DB.prepare('UPDATE nudges SET status = ?, at = ? WHERE uid = ? AND kind = ?').bind(r.ok ? 'sent' : 'failed', new Date().toISOString(), c.uid, c.kind).run()
    if (r.ok) sent++; else { failed++; await markUnreachable(env.DB, c.uid, r.description) }
  }
  return { sent, failed }
}

// ---- Cron va admin hisoboti -----------------------------------------------------------------------

/** Har 15 daqiqa: so'nggi 30 kunda ochilgan, hali "qaytib kelmagan" do'konlar holati + eslatmalar. */
export async function runFunnelCron(env: Env, now: Date, trialDays: number): Promise<{ refreshed: number; sent: number; failed: number }> {
  const rows = (await env.DB.prepare(
    `SELECT uid, shop_id FROM funnel_users WHERE shop_id IS NOT NULL AND day2_at IS NULL AND shop_at >= ?
     ORDER BY checked_at IS NOT NULL, checked_at LIMIT 100`,
  ).bind(new Date(now.getTime() - 30 * DAY).toISOString()).all<{ uid: number; shop_id: string }>()).results
  await refreshProgress(env, rows, now.toISOString())
  if (!(await nudgesEnabled(env.DB)) || !inSendWindow(now)) return { refreshed: rows.length, sent: 0, failed: 0 }
  return { refreshed: rows.length, ...await sendNudges(env, now, trialDays) }
}

export type FunnelRow = {
  uid: number; name: string | null; username: string | null; lang: string | null; src: string | null
  started_at: string | null; opened_at: string | null; shop_id: string | null; shop_at: string | null
  products: number; sales: number; product_at: string | null; sale_at: string | null; day2_at: string | null; last_sale_at: string | null
  pm_at: string | null; created_at: string; shop_name: string | null; nudges: { kind: string; status: string; at: string }[]
}

/** Admin "Varonka": davr (kun; 0 — hammasi) bo'yicha bosqichlar, manbalar va odamlar ro'yxati. Adminlar kirmaydi. */
export async function funnelReport(env: Env, days: number, now: Date) {
  const since = days > 0 ? new Date(now.getTime() - days * DAY).toISOString() : '0000'
  const admins = (env.ADMIN_CHAT_ID ?? '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isSafeInteger(x) && x > 0)
  const notAdmin = admins.length ? `AND f.uid NOT IN (${admins.map(() => '?').join(',')})` : ''
  const nowIso = now.toISOString()
  // Ro'yxatdagi do'konlar holati jonli (2 daqiqadan eski bo'lsa).
  const stale = (await env.DB.prepare(
    `SELECT f.uid, f.shop_id FROM funnel_users f WHERE f.shop_id IS NOT NULL AND f.created_at >= ? ${notAdmin}
       AND (f.checked_at IS NULL OR f.checked_at < ?) ORDER BY f.created_at DESC LIMIT 200`,
  ).bind(since, ...admins, new Date(now.getTime() - 2 * MIN).toISOString()).all<{ uid: number; shop_id: string }>()).results
  await refreshProgress(env, stale, nowIso)

  const stages = await env.DB.prepare(
    `SELECT COUNT(*) entered, COUNT(f.started_at) started, COUNT(f.opened_at) opened, COUNT(f.shop_at) shop,
            COUNT(f.product_at) product, COUNT(f.sale_at) sale, COUNT(f.day2_at) day2, COUNT(f.pm_at) pm
     FROM funnel_users f WHERE f.created_at >= ? ${notAdmin}`,
  ).bind(since, ...admins).first<Record<string, number>>()
  const sources = (await env.DB.prepare(
    `SELECT COALESCE(f.src, '') src, COUNT(*) n, COUNT(f.shop_at) shop, COUNT(f.sale_at) sale
     FROM funnel_users f WHERE f.created_at >= ? ${notAdmin} GROUP BY 1 ORDER BY n DESC LIMIT 20`,
  ).bind(since, ...admins).all<{ src: string; n: number; shop: number; sale: number }>()).results
  const rows = (await env.DB.prepare(
    `SELECT f.uid, f.name, f.username, f.lang, f.src, f.started_at, f.opened_at, f.shop_id, f.shop_at, f.products, f.sales,
            f.product_at, f.sale_at, f.day2_at, f.last_sale_at, f.pm_at, f.created_at, t.name shop_name
     FROM funnel_users f LEFT JOIN tenants t ON t.id = f.shop_id
     WHERE f.created_at >= ? ${notAdmin} ORDER BY f.created_at DESC LIMIT 200`,
  ).bind(since, ...admins).all<Omit<FunnelRow, 'nudges'>>()).results
  const nudgeRows = rows.length
    ? (await env.DB.prepare(`SELECT uid, kind, status, at FROM nudges WHERE uid IN (${rows.map(() => '?').join(',')}) AND status != 'skipped' ORDER BY at`)
      .bind(...rows.map((r) => r.uid)).all<{ uid: number; kind: string; status: string; at: string }>()).results
    : []
  const byUid = new Map<number, FunnelRow['nudges']>()
  for (const n of nudgeRows) byUid.set(n.uid, [...(byUid.get(n.uid) ?? []), { kind: n.kind, status: n.status, at: n.at }])
  return {
    days,
    stages: stages ?? { entered: 0, started: 0, opened: 0, shop: 0, product: 0, sale: 0, day2: 0, pm: 0 },
    sources,
    rows: rows.map((r) => ({ ...r, nudges: byUid.get(r.uid) ?? [] })),
    nudges: { enabled: await nudgesEnabled(env.DB), support: !!env.SUPPORT_USERNAME },
  }
}

// ---- Qo'lda yozish (asoschi xabari) ---------------------------------------------------------------

export type OutreachButton = { text: string; url?: string; app?: string }
export type OutreachInput = { uid: number; key: string; text: string; buttons: OutreachButton[] }

const OUT_KEY = /^[A-Za-z0-9_-]{1,40}$/
const T_ME = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}$/
const APP_PATH = /^[a-z0-9/?=&_-]{0,80}$/

/** Kirishni tekshiradi: faqat t.me havola yoki ilova bo'limi tugmasi; matn ≤ 3000. Xato bo'lsa — maydon nomi. */
export function parseOutreach(body: Record<string, unknown> | null): OutreachInput | string {
  const uid = body?.uid
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 0) return 'uid'
  if (typeof body?.key !== 'string' || !OUT_KEY.test(body.key)) return 'key'
  if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 3000) return 'text'
  const raw = Array.isArray(body?.buttons) ? body.buttons : []
  if (raw.length > 4) return 'buttons'
  const buttons: OutreachButton[] = []
  for (const b of raw as Record<string, unknown>[]) {
    if (!b || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 40) return 'buttons'
    if (typeof b.url === 'string' && T_ME.test(b.url)) buttons.push({ text: b.text, url: b.url })
    else if (typeof b.app === 'string' && APP_PATH.test(b.app)) buttons.push({ text: b.text, app: b.app })
    else return 'buttons'
  }
  return { uid, key: body.key, text: body.text, buttons }
}

/**
 * Ro'yxatdagi (varonka yoki a'zo) odamga bot orqali bitta xabar. (uid, `manual:<key>`) bo'yicha ko'pi bilan BIR
 * marta — yozuv yuborishdan OLDIN; takror so'rov yuborilmaydi, avvalgi holat qaytadi.
 */
export async function sendOutreach(env: Env, o: OutreachInput, now: Date): Promise<{ status: string; description?: string } | null> {
  const known = await env.DB.prepare('SELECT 1 FROM funnel_users WHERE uid = ? UNION SELECT 1 FROM members WHERE uid = ? LIMIT 1').bind(o.uid, o.uid).first()
  if (!known) return null
  const kind = `manual:${o.key}`
  const ins = await env.DB.prepare("INSERT INTO nudges (uid, kind, status, at) VALUES (?, ?, 'pending', ?) ON CONFLICT(uid, kind) DO NOTHING")
    .bind(o.uid, kind, now.toISOString()).run()
  if (!ins.meta.changes) {
    const prev = await env.DB.prepare('SELECT status FROM nudges WHERE uid = ? AND kind = ?').bind(o.uid, kind).first<{ status: string }>()
    return { status: `already_${prev?.status ?? 'pending'}` }
  }
  const app = env.APP_URL.replace(/\/+$/, '')
  const keyboard = o.buttons.map((b) => [b.url ? { text: b.text, url: b.url } : { text: b.text, web_app: { url: `${app}/${b.app ?? ''}` } }])
  const r = await tgCall(env, 'sendMessage', {
    chat_id: o.uid, text: o.text, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  })
  await env.DB.prepare('UPDATE nudges SET status = ?, at = ? WHERE uid = ? AND kind = ?').bind(r.ok ? 'sent' : 'failed', new Date().toISOString(), o.uid, kind).run()
  if (r.ok) await markWriteAccess(env.DB, o.uid, new Date().toISOString())
  else await markUnreachable(env.DB, o.uid, r.description)
  return r.ok ? { status: 'sent' } : { status: 'failed', description: r.description }
}
