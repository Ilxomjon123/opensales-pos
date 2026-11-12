import type { Env } from './env'
import { displayName, verifyInitData, type VerifiedInitData } from './auth/initData'
import { bearer, signSession, verifySession, type SessionPayload } from './auth/session'
import {
  acceptInvite, createInvite, createShop, createTenant, defaultMembership, findMembership, findTenant, isAdminUid, randomId, listInvites, listMembers,
  listMemberships, listTenants, revokeInvites, setActiveTenant, setMemberActive, setPaidUntil, setTenantAi, setTenantStatus, subscriptionOf, tenantState,
  tenantUntil, trialDays, type MemberWithTenant, type TenantRow,
} from './registry'
import { endOfTashkentDay, handleUpdate } from './telegram/bot'
import { chatOnly, draftCardHtml, markReplaced, type Lang } from './telegram/assistantBot'
import type { ChatEntry } from './shop/chats'
import { cbuRates, withFx } from './assistant/fx'
import { escapeHtml, tgCall } from './telegram/api'
import { cardHtml, parseCard } from './telegram/receiptCard'
import { applyProfile } from './telegram/profile'
import type { Actor, RpcResult } from './shop/rpc'
import { cleanEdits, runAssistant } from './assistant/pipeline'
import { DEFAULT_GEMINI_MODEL, geminiAssist } from './assistant/gemini'
import type { ApplyOutcome, Draft } from './shop/assistant'
import type { Guarded, PlanLine, TransferRow } from './shop/transfers'

import { CATALOG_FANOUT_OPS, copyCatalog, shopStub, syncBranchesOf, syncCatalog } from './catalog'
import { canMessage, cleanSrc, funnelReport, markWriteAccess, parseOutreach, quietly, runFunnelCron, sendOutreach, setNudgesEnabled, trackOpen, trackShop, type Who } from './funnel'

export { ShopDO } from './shop/ShopDO'

// OpenSales Kassa — Telegram Mini App POS. Hammasi shu Worker'da:
//   /api/*  — kirish (initData → sessiya), RPC (do'kon Durable Object'iga), xodimlar, eksport
//   /img/*  — mahsulot rasmlari (DO'dagi BLOB, edge kesh)
//   /tg/*   — bot webhook
//   qolgani — statik SPA (assets)

const MAX_JSON_BYTES = 1_000_000 // rasm (≤300KB) base64 bilan sig'adi
const MAX_EXPORT_BYTES = 8_000_000

const nowSec = () => Math.floor(Date.now() / 1000)

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  })
}

function fail(status: number, code: string, params: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: { code, params, status } }, status)
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get('Content-Length') ?? '0')
  if (len > MAX_JSON_BYTES) return null
  const text = await req.text()
  if (text.length > MAX_JSON_BYTES) return null
  try {
    const v = JSON.parse(text || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const shop = shopStub

function actorOf(s: SessionPayload): Actor {
  return { uid: s.u, role: s.r, name: s.n }
}

async function initDataFrom(body: Record<string, unknown>, env: Env): Promise<VerifiedInitData | null> {
  return typeof body.initData === 'string' ? verifyInitData(body.initData, env.BOT_TOKEN, nowSec()) : null
}

/** Ilovadagi do'konlar ro'yxati (faqat faol a'zoliklar). */
function shopsView(all: MemberWithTenant[]) {
  const names = new Map(all.map((x) => [x.tenant_id, x.tenant.name]))
  return all.filter((x) => x.active).map((x) => ({
    id: x.tenant_id, name: x.tenant.name, role: x.role, group: x.tenant.group_id, root: x.tenant.id === x.tenant.group_id,
    catalogOf: x.tenant.catalog_of, catalogOfName: x.tenant.catalog_of ? names.get(x.tenant.catalog_of) ?? null : null,
  }))
}

/** Kirish javobi: token + do'kon holati (bitta so'rovda — ilova darhol ochilsin). */
/**
 * `initPm` — initData'da `allows_write_to_pm` (faqat initData bilan kirishda ma'lum). Javobdagi `pm` — bot egaga
 * yoza oladimi (eslatma, Excel, kassir qo'shildi xabari); `false` bo'lsa ilova ruxsat so'raydi. Kassirga — null.
 */
async function sessionResponse(env: Env, m: MemberWithTenant, abs?: number, initPm = false): Promise<Response> {
  const token = await signSession({ t: m.tenant_id, u: m.uid, r: m.role, n: m.name, abs }, env.SESSION_KEY, nowSec())
  // Filial: ochilishda katalog asosiy do'kondan yangilanadi (o'zgarish bo'lmasa — bitta arzon so'rov).
  if (m.tenant.catalog_of) await syncCatalog(env, m.tenant.catalog_of, m.tenant_id).catch((e) => console.error('catalog sync', e))
  const pmOf = async (): Promise<boolean | null> =>
    m.role !== 'owner' ? null : initPm || canMessage(env.DB, m.uid).catch(() => null)
  const [boot, all, pm] = await Promise.all([shop(env, m.tenant_id).bootstrap({ uid: m.uid, role: m.role, name: m.name }), listMemberships(env.DB, m.uid), pmOf()])
  const shops = shopsView(all)
  const current = shops.find((x) => x.id === m.tenant_id)
  return json({
    ok: true,
    status: 'ok',
    token,
    user: { uid: m.uid, name: m.name, role: m.role },
    shop: { id: m.tenant_id, name: m.tenant.name, group: m.tenant.group_id, catalogOf: m.tenant.catalog_of, catalogOfName: current?.catalogOfName ?? null },
    shops,
    bot: env.BOT_USERNAME,
    admin: isAdminUid(env.ADMIN_CHAT_ID, m.uid),
    ai: m.tenant.ai_enabled !== 0,
    pm,
    ...boot,
  })
}

/** Admin ko'rish rejimi (KO'RISH tokeni) — ko'pi bilan shuncha soniya, keyin admin qaytadan kiradi. */
const VIEW_ABSOLUTE = 6 * 3600

/**
 * Admin do'konni ko'rish rejimida ochadi: token `v: 1` (faqat o'qish op'lari), user shu do'kon a'zosi
 * qilinMAYDI, botdagi tanlov (active_tenant) o'zgarmaydi, filial katalogi tortilmaydi — do'konga hech narsa yozilmaydi.
 */
async function viewResponse(env: Env, t: TenantRow, admin: { uid: number; name: string }, abs: number): Promise<Response> {
  const token = await signSession({ t: t.id, u: admin.uid, r: 'owner', n: admin.name, abs, v: 1 }, env.SESSION_KEY, nowSec())
  const [boot, parent, owner] = await Promise.all([
    shop(env, t.id).bootstrap({ uid: admin.uid, role: 'owner', name: admin.name }),
    t.catalog_of ? findTenant(env.DB, t.catalog_of) : null,
    findMembership(env.DB, t.owner_uid, t.id),
  ])
  return json({
    ok: true,
    status: 'ok',
    token,
    user: { uid: admin.uid, name: admin.name, role: 'owner' },
    shop: { id: t.id, name: t.name, group: t.group_id, catalogOf: t.catalog_of, catalogOfName: parent?.name ?? null },
    shops: [],
    bot: env.BOT_USERNAME,
    admin: true,
    ai: false,
    view: { owner: owner?.username ? '@' + owner.username : owner?.name ?? String(t.owner_uid) },
    ...boot,
    shift: null,
  })
}

/**
 * Ko'rish tokeni faqat shu yo'llarda: RPC (DO o'zi yozuvchini rad etadi), yangilash, Excel (adminning o'z chatiga),
 * ko'rishdan chiqish. Qolgani (xodimlar, ko'chirish, chek, yordamchi, admin amallari...) — 403.
 */
const VIEW_PATHS = ['/api/session/refresh', '/api/export', '/api/admin/exit']
async function viewGuard(req: Request, env: Env, p: string): Promise<Response | null> {
  const t = bearer(req)
  if (!t || p.startsWith('/api/rpc/') || VIEW_PATHS.includes(p)) return null
  const s = await verifySession(t, env.SESSION_KEY, nowSec(), { allowExpired: true })
  return s?.v === 1 ? fail(403, 'cloud.admin.viewOnly') : null
}

async function authed(req: Request, env: Env): Promise<SessionPayload | null> {
  const t = bearer(req)
  return t ? verifySession(t, env.SESSION_KEY, nowSec()) : null
}

/** Egasi ekanini D1'dan tekshiradi (xodimlarni boshqarish kabi kam uchraydigan amallar uchun). */
async function ownerMember(env: Env, s: SessionPayload): Promise<MemberWithTenant | null> {
  const m = await findMembership(env.DB, s.u, s.t)
  return m && m.active && m.role === 'owner' ? m : null
}

/**
 * Do'konlararo ko'chirish (ikkala do'konda EGA, bitta biznes). Ketma-ketlik va kafolatlar — shop/transfers.ts:
 * moslash rejasi → manbada chiqim (pending) → qabulda kirim → manbada done. Qabul bosqichi yiqilsa ko'chirish
 * `pending` qoladi va manba alarm'i qayta yuboradi; o'sha `id` bilan qayta so'rov ham davom ettiradi.
 */
async function handleTransfers(req: Request, env: Env, action: string): Promise<Response> {
  const s = await authed(req, env)
  if (!s) return fail(401, 'cloud.errors.sessionExpired')
  const owner = await ownerMember(env, s)
  if (!owner) return fail(403, 'cloud.errors.forbidden')
  const actor: Actor = { uid: s.u, role: 'owner', name: s.n }
  const src = shop(env, s.t)
  if (action === 'list') {
    const rows = (await src.transfers(actor)) as TransferRow[] | null
    return rows ? json({ ok: true, data: rows }) : fail(403, 'cloud.errors.forbidden')
  }
  if (action !== 'create') return fail(404, 'cloud.errors.notFound', { what: 'route' })
  const body = await readJson(req)
  const id = typeof body?.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.id) ? body.id : null
  if (!id) return fail(400, 'cloud.errors.invalidInput', { field: 'id' })
  const toId = typeof body?.toShopId === 'string' && /^[a-f0-9]{32}$/.test(body.toShopId) ? body.toShopId : null
  if (!toId || toId === s.t) return fail(400, 'cloud.errors.invalidInput', { field: 'toShopId' })
  const target = await findMembership(env.DB, s.u, toId)
  if (!target || !target.active || target.role !== 'owner' || target.tenant.group_id !== owner.tenant.group_id) return fail(403, 'cloud.errors.forbidden')
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : null
  const items = Array.isArray(body?.items) ? (body.items as unknown[]).map((x) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    return { productId: Number(o.productId), qty: Number(o.qty) }
  }) : []
  if (items.some((x) => !Number.isSafeInteger(x.productId) || x.productId <= 0 || !Number.isFinite(x.qty))) return fail(400, 'cloud.errors.invalidInput', { field: 'items' })
  const dst = shop(env, toId)

  const finish = async (out: TransferRow | null) => {
    if (!out) return fail(404, 'cloud.errors.notFound', { what: 'transfer' })
    if (out.status === 'done') return json({ ok: true, data: out })
    const r = (await dst.transferIn(actor, { id: out.id, peer: s.t, peerName: owner.tenant.name, lines: out.items, note: out.note })) as Guarded<TransferRow>
    if (!r.ok) return json({ ok: true, data: out, pending: r.error })
    await src.transferDone(out.id)
    return json({ ok: true, data: (await src.transfer(out.id)) as TransferRow | null })
  }
  // Takroriy so'rov (tarmoq uzilgan) — mavjud ko'chirish davom ettiriladi.
  const prior = (await src.transfer(id)) as TransferRow | null
  if (prior) return prior.direction === 'out' && prior.peer_tenant === toId ? finish(prior) : fail(409, 'cloud.errors.invalidInput', { field: 'id' })

  // Filial: moslashdan oldin katalogi yangilansin (asosiyda hozirgina yaratilgan tovar ham bo'lsin).
  if (target.tenant.catalog_of) await syncCatalog(env, target.tenant.catalog_of, toId).catch(() => undefined)
  const shared = (owner.tenant.catalog_of ?? owner.tenant_id) === (target.tenant.catalog_of ?? target.tenant_id)
  const lines = (await src.transferDescribe(actor, items)) as Guarded<PlanLine[]>
  if (!lines.ok) return json({ ok: false, error: lines.error }, lines.error.status)
  const plan = (await dst.transferPlan(actor, lines.data, shared)) as Guarded<{ targetProductId: number | null }[]>
  if (!plan.ok) return json({ ok: false, error: plan.error }, plan.error.status)
  const out = (await src.transferOut(actor, { id, peer: toId, peerName: target.tenant.name, input: items, targets: plan.data, note })) as Guarded<TransferRow>
  if (!out.ok) return json({ ok: false, error: out.error }, out.error.status)
  return finish(out.data)
}

/**
 * Umumiy hisobot: user EGA bo'lgan, joriy biznesdagi har do'kon uchun `businessSummary` + jami.
 * Kassir yoki boshqa biznes do'koni kirmaydi.
 */
async function handleGroupReport(req: Request, env: Env): Promise<Response> {
  const s = await authed(req, env)
  if (!s) return fail(401, 'cloud.errors.sessionExpired')
  const owner = await ownerMember(env, s)
  if (!owner) return fail(403, 'cloud.errors.forbidden')
  const body = await readJson(req)
  const day = (x: unknown) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null)
  const from = day(body?.from), to = day(body?.to)
  if (!from || !to || from > to) return fail(400, 'cloud.errors.invalidInput', { field: 'period' })
  const shops = (await listMemberships(env.DB, s.u)).filter((m) => m.active && m.role === 'owner' && m.tenant.group_id === owner.tenant.group_id)
  const actor: Actor = { uid: s.u, role: 'owner', name: s.n }
  const rows = await Promise.all(shops.map(async (m) => {
    const r = (await shop(env, m.tenant_id).rpc('businessSummary', [from, to], actor, null)) as RpcResult
    return { id: m.tenant_id, name: m.tenant.name, branch: !!m.tenant.catalog_of, ...(r.ok ? { data: r.data as Record<string, number> } : { error: r.error.code }) }
  }))
  const keys = ['count', 'gross', 'total', 'cash', 'card', 'debt', 'returns', 'profit', 'expenses', 'net', 'receivable', 'debtors', 'advance', 'stockCost', 'stockRetail', 'products']
  const total: Record<string, number> = Object.fromEntries(keys.map((k) => [k, rows.reduce((a, r) => a + (('data' in r && r.data ? Number(r.data[k]) : 0) || 0), 0)]))
  return json({ ok: true, data: { from, to, shops: rows, total } })
}

/** Obuna guruh bo'ylab: har do'kon DO'sidagi nusxa yangilanadi (402 darhol yechiladi/qo'yiladi). */
export async function syncSubscriptions(env: Env, rows: TenantRow[]): Promise<void> {
  await Promise.all(rows.map((t) => shop(env, t.id).setSubscription(subscriptionOf(t))))
}

// ---------------------------------------------------------------------------

async function handleSession(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'cloud.errors.invalidInput', { field: 'body' })
  const init = await initDataFrom(body, env)
  if (!init) return fail(401, 'cloud.errors.badInitData')
  const user = { uid: init.user.id, name: displayName(init.user), username: init.user.username ?? null }

  // Taklif: ?inv= (bot tugmasi) yoki startapp=inv_<token> (imzolangan start_param).
  const invite = typeof body.invite === 'string' ? body.invite : init.startParam?.startsWith('inv_') ? init.startParam.slice(4) : null
  let member = await defaultMembership(env.DB, user.uid)
  // Bir odam bir nechta do'konda bo'la oladi: taklif har doim shu do'kon a'zoligini beradi (yoki mavjudini).
  if (invite) {
    const before = await listMemberships(env.DB, user.uid)
    const r = await acceptInvite(env.DB, invite, user, new Date())
    if ('error' in r) {
      if (!member || !member.active) return fail(409, `cloud.errors.invite.${r.error}`)
    } else {
      const was = before.find((x) => x.tenant_id === r.member.tenant_id)
      member = r.member
      if (!was || !was.active || was.role !== r.member.role) {
        await shop(env, member.tenant_id).syncMember({ uid: member.uid, name: member.name, role: member.role, active: true })
        ctx.waitUntil(notifyOwner(env, member))
      }
    }
  }
  // Varonka: yangi odam yoki ega (kassir va taklif bilan kirgan — emas). Xato kirishni buzmaydi.
  if (!invite && (!member || member.role === 'owner')) {
    ctx.waitUntil(quietly(trackOpen(env.DB, whoOf(init), cleanSrc(init.startParam), new Date().toISOString()), 'open'))
  }
  if (!member) return json({ ok: true, status: 'new', user: { uid: user.uid, name: user.name } })
  if (!member.active) return fail(403, 'cloud.errors.memberRevoked')
  return sessionResponse(env, member, undefined, init.user.allows_write_to_pm === true)
}

function whoOf(init: VerifiedInitData): Who {
  return { uid: init.user.id, name: displayName(init.user), username: init.user.username ?? null, lang: init.user.language_code ?? null, pm: init.user.allows_write_to_pm === true }
}

/**
 * Ilovadagi Telegram oynasida "xabar yozishga ruxsat" berildi (`requestWriteAccess` → allowed). initData bilan
 * (yangi odamda token yo'q). Faqat o'z varonka qatoriga belgi qo'yiladi — eslatmalar endi unga ham boradi.
 */
async function handleWriteAccess(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'cloud.errors.invalidInput', { field: 'body' })
  const init = await initDataFrom(body, env)
  if (!init) return fail(401, 'cloud.errors.badInitData')
  if (body.allowed !== true) return fail(400, 'cloud.errors.invalidInput', { field: 'allowed' })
  await markWriteAccess(env.DB, init.user.id, new Date().toISOString())
  return json({ ok: true })
}

async function notifyOwner(env: Env, m: MemberWithTenant) {
  await tgCall(env, 'sendMessage', {
    chat_id: m.tenant.owner_uid,
    text: m.role === 'owner'
      ? `👑 ${escapeHtml(m.name)} do'konga egasi sifatida (to'liq huquq) ulandi.`
      : `🤝 ${escapeHtml(m.name)} kassir sifatida qo'shildi.`,
    parse_mode: 'HTML',
  })
}

async function handleOnboard(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'cloud.errors.invalidInput', { field: 'body' })
  const init = await initDataFrom(body, env)
  if (!init) return fail(401, 'cloud.errors.badInitData')
  const shopName = typeof body.shopName === 'string' ? body.shopName.trim().replace(/\s+/g, ' ') : ''
  if (shopName.length < 2 || shopName.length > 80) return fail(400, 'cloud.errors.invalidInput', { field: 'shopName' })
  const r = await createTenant(env.DB, { uid: init.user.id, name: displayName(init.user), username: init.user.username ?? null, shopName, trialDays: trialDays(env.TRIAL_DAYS), now: new Date() })
  if (!r) return fail(409, 'cloud.errors.alreadyCashier')
  const m = r.member
  if (r.created) ctx.waitUntil(quietly(trackShop(env.DB, whoOf(init), m.tenant_id, new Date().toISOString()), 'shop'))
  // Takror chaqiruv ham xavfsiz (oldingi urinishda DO init yiqilgan bo'lsa tuzaladi).
  await shop(env, m.tenant_id).init({
    tenantId: m.tenant_id, shopName: m.tenant.name, owner: { uid: m.uid, name: m.name }, subscription: subscriptionOf(m.tenant),
  })
  if (r.created && env.ADMIN_CHAT_ID) {
    const who = init.user.username ? '@' + init.user.username : `<a href="tg://user?id=${m.uid}">${escapeHtml(m.name)}</a>`
    ctx.waitUntil(tgCall(env, 'sendMessage', {
      chat_id: env.ADMIN_CHAT_ID,
      text: `🆕 Yangi do'kon: <b>${escapeHtml(shopName)}</b>\n${who} · <code>${m.tenant_id.slice(0, 8)}</code>\nSinov: ${m.tenant.trial_until.slice(0, 10)} gacha`,
      parse_mode: 'HTML',
    }))
  }
  return sessionResponse(env, m, undefined, init.user.allows_write_to_pm === true)
}

async function handleRefresh(req: Request, env: Env): Promise<Response> {
  const t = bearer(req)
  const s = t ? await verifySession(t, env.SESSION_KEY, nowSec(), { allowExpired: true }) : null
  if (!s) return fail(401, 'cloud.errors.sessionExpired')
  if (s.v === 1) {
    // Admin huquqi olingan yoki do'kon yo'q — 401: ilova initData bilan o'z do'koniga qaytadi (403 "chetlatilgan" emas).
    const t = isAdminUid(env.ADMIN_CHAT_ID, s.u) ? await findTenant(env.DB, s.t) : null
    return t ? viewResponse(env, t, { uid: s.u, name: s.n }, s.abs) : fail(401, 'cloud.errors.sessionExpired')
  }
  const m = await findMembership(env.DB, s.u, s.t)
  if (!m || !m.active) return fail(403, 'cloud.errors.memberRevoked')
  return sessionResponse(env, m, s.abs)
}

/** Boshqa do'konga o'tish: faqat faol a'zolik bo'lsa; yangi token o'sha do'konga, tanlov eslab qolinadi (bot ham). */
async function handleSwitch(req: Request, env: Env): Promise<Response> {
  const s = await authed(req, env)
  if (!s) return fail(401, 'cloud.errors.sessionExpired')
  const body = await readJson(req)
  const id = typeof body?.shopId === 'string' && /^[a-f0-9]{32}$/.test(body.shopId) ? body.shopId : null
  if (!id) return fail(400, 'cloud.errors.invalidInput', { field: 'shopId' })
  const m = await findMembership(env.DB, s.u, id)
  if (!m || !m.active) return fail(403, 'cloud.errors.forbidden')
  await setActiveTenant(env.DB, s.u, id)
  return sessionResponse(env, m, s.abs)
}

/**
 * Yangi do'kon (joriy biznesga): faqat joriy do'kon egasi. `catalogOf` — filial (katalog shu do'kondan).
 * Obuna biznes ildizidan; yangi do'kon DO'si yaratiladi, egalar sinxronlanadi, user o'sha do'konga o'tadi.
 */
async function handleCreateShop(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const s = await authed(req, env)
  if (!s) return fail(401, 'cloud.errors.sessionExpired')
  const owner = await ownerMember(env, s)
  if (!owner) return fail(403, 'cloud.errors.forbidden')
  const body = await readJson(req)
  const shopName = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : ''
  if (shopName.length < 2 || shopName.length > 80) return fail(400, 'cloud.errors.invalidInput', { field: 'name' })
  const catalogOf = body?.catalogOf === null || body?.catalogOf === undefined ? null
    : typeof body.catalogOf === 'string' && /^[a-f0-9]{32}$/.test(body.catalogOf) ? body.catalogOf : 'bad'
  if (catalogOf === 'bad') return fail(400, 'cloud.errors.invalidInput', { field: 'catalogOf' })
  const copyFrom = typeof body?.copyFrom === 'string' && /^[a-f0-9]{32}$/.test(body.copyFrom) ? body.copyFrom : null
  if (catalogOf && copyFrom) return fail(400, 'cloud.errors.invalidInput', { field: 'copyFrom' })
  const groupId = owner.tenant.group_id
  // Katalog manbai / nusxa manbai — user o'zi ega bo'lgan, shu biznesdagi do'kon bo'lsin.
  for (const src of [catalogOf, copyFrom]) {
    if (!src) continue
    const sm = await findMembership(env.DB, s.u, src)
    if (!sm || !sm.active || sm.role !== 'owner' || sm.tenant.group_id !== groupId) return fail(403, 'cloud.errors.forbidden')
  }
  const r = await createShop(env.DB, { creator: { uid: s.u, name: owner.name, username: owner.username }, groupId, shopName, catalogOf, now: new Date() })
  if ('error' in r) {
    if (r.error === 'limit') return fail(409, 'cloud.shops.errors.limit')
    if (r.error === 'nameTaken') return fail(409, 'cloud.shops.errors.nameTaken')
    return fail(400, 'cloud.errors.invalidInput', { field: 'catalogOf' })
  }
  const m = r.member
  const stub = shop(env, m.tenant_id)
  await stub.init({ tenantId: m.tenant_id, shopName: m.tenant.name, owner: { uid: m.uid, name: m.name }, subscription: subscriptionOf(m.tenant), catalogOf: m.tenant.catalog_of })
  // Biznes egasi (ildizni ochgan) yangi do'konda ham ega.
  for (const x of await listMembers(env.DB, m.tenant_id)) {
    if (x.uid !== m.uid) await stub.syncMember({ uid: x.uid, name: x.name, role: x.role, active: !!x.active })
  }
  if (r.created) {
    if (m.tenant.catalog_of) await syncCatalog(env, m.tenant.catalog_of, m.tenant_id)
    else if (copyFrom) await copyCatalog(env, copyFrom, m.tenant_id)
  }
  await setActiveTenant(env.DB, s.u, m.tenant_id)
  if (r.created && env.ADMIN_CHAT_ID) {
    ctx.waitUntil(tgCall(env, 'sendMessage', {
      chat_id: env.ADMIN_CHAT_ID,
      text: `➕ ${m.tenant.catalog_of ? 'Filial' : "Yangi do'kon"}: <b>${escapeHtml(shopName)}</b> — ${escapeHtml(owner.tenant.name)} biznesida (<code>${m.tenant_id.slice(0, 8)}</code>)`,
      parse_mode: 'HTML',
    }))
  }
  return sessionResponse(env, m)
}

async function handleRpc(req: Request, env: Env, ctx: ExecutionContext, op: string): Promise<Response> {
  const s = await authed(req, env)
  if (!s) return fail(401, 'cloud.errors.sessionExpired')
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(op)) return fail(404, 'cloud.errors.unknownOp', { op })
  const body = await readJson(req)
  if (!body) return fail(413, 'cloud.errors.tooLarge')
  if (s.v === 1) {
    // Ko'rish rejimi: admin huquqi har so'rovda (ro'yxatdan olinsa darhol to'xtaydi); yozish DO'da rad etiladi.
    if (!isAdminUid(env.ADMIN_CHAT_ID, s.u)) return fail(401, 'cloud.errors.sessionExpired')
    const v = (await shop(env, s.t).viewRpc(op, body.args ?? [], actorOf(s))) as RpcResult
    return v.ok ? json(v) : json(v, v.error.status)
  }
  const key = req.headers.get('Idempotency-Key')
  const r = (await shop(env, s.t).rpc(op, body.args ?? [], actorOf(s), key)) as RpcResult
  // Asosiy do'kon katalogi o'zgardi — filiallarga (javobni kutdirmasdan).
  if (r.ok && !r.replayed && CATALOG_FANOUT_OPS.has(op)) ctx.waitUntil(syncBranchesOf(env, s.t))
  return r.ok ? json(r) : json(r, r.error.status)
}

async function handleImage(req: Request, env: Env, ctx: ExecutionContext, tid: string, pid: number, ver: string): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default
  const hit = await cache.match(req)
  if (hit) return hit
  // Mavjud bo'lmagan do'kon nomi uchun DO yaratilmasin.
  const tenant = await findTenant(env.DB, tid)
  if (!tenant) return new Response('Not found', { status: 404 })
  // Filialda rasm saqlanmaydi — katalog (va rasmlar) asosiy do'konda.
  const img = (await shop(env, tid).getImage(pid, ver)) ?? (tenant.catalog_of ? await shop(env, tenant.catalog_of).getImage(pid, ver) : null)
  if (!img) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } })
  const res = new Response(img.data, {
    headers: {
      'Content-Type': img.mime,
      // Versiya manzilda — rasm almashsa manzil ham o'zgaradi.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
  ctx.waitUntil(cache.put(req, res.clone()))
  return res
}

/** Excel/CSV faylni egasining (yoki xodimning) Telegram chatiga yuboradi. */
async function handleExport(req: Request, env: Env): Promise<Response> {
  const s = await authed(req, env)
  if (!s) return fail(401, 'cloud.errors.sessionExpired')
  const url = new URL(req.url)
  const name = (url.searchParams.get('name') ?? 'export.xlsx').replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 100) || 'export.xlsx'
  if (!/\.(xlsx|csv)$/i.test(name)) return fail(400, 'cloud.errors.invalidInput', { field: 'name' })
  const len = Number(req.headers.get('Content-Length') ?? '0')
  if (len > MAX_EXPORT_BYTES) return fail(413, 'cloud.errors.tooLarge')
  const bytes = await req.arrayBuffer()
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_EXPORT_BYTES) return fail(413, 'cloud.errors.tooLarge')
  const type = name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const form = new FormData()
  form.set('chat_id', String(s.u))
  form.set('document', new File([bytes], name, { type }))
  const r = await tgCall(env, 'sendDocument', form)
  // Bot yoza olmaydi: bloklagan (403) yoki botni hech ochmagan ("chat not found") — ilova ruxsat so'rab qayta urinadi.
  if (!r.ok) {
    const blocked = r.status === 403 || /chat not found/i.test(r.description)
    return fail(blocked ? 409 : 502, blocked ? 'cloud.errors.botBlocked' : 'cloud.errors.telegramFailed')
  }
  return json({ ok: true })
}

/** Chek matnini xodimning Telegram chatiga — u mijozga forward qiladi. */
/**
 * Chekni ulashish: xodimning o'ziga yuborilMAYDI — Telegram'da "tayyor xabar" (savePreparedInlineMessage)
 * yaratiladi, ilova `shareMessage(id)` bilan chat tanlash oynasini ochadi va xodim mijozga/guruhga yuboradi.
 * Xabar HTML (receiptCard.ts), hamma satr escape qilingan. Tayyor xabar faqat shu foydalanuvchiga tegishli.
 */
async function handleReceipt(req: Request, env: Env): Promise<Response> {
  const s = await authed(req, env)
  if (!s) return fail(401, 'cloud.errors.sessionExpired')
  const body = await readJson(req)
  const card = parseCard(body?.card)
  if (!card) return fail(400, 'cloud.errors.invalidInput', { field: 'card' })
  // Chek rasmi (ixtiyoriy): JPEG, ≤1.5 MB — Telegram o'zi photo_url'dan oladi; izohda matn.
  let photoUrl: string | null = null
  if (typeof body?.image === 'string' && body.image.length < 2_100_000) {
    let bytes: Uint8Array | null = null
    try { bytes = Uint8Array.from(atob(body.image), (c) => c.charCodeAt(0)) } catch { /* noto'g'ri base64 */ }
    if (!bytes || bytes.length < 1000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return fail(400, 'cloud.errors.invalidInput', { field: 'image' })
    const imgId = randomId(16)
    await shop(env, s.t).putReceiptImage(imgId, bytes)
    photoUrl = `${env.APP_URL.replace(/\/+$/, '')}/rimg/${s.t}/${imgId}.jpg`
  }
  const r = await tgCall<{ id: string; expiration_date: number }>(env, 'savePreparedInlineMessage', preparedReceipt(s.u, card, photoUrl))
  if (!r.ok) return fail(502, 'cloud.errors.telegramFailed')
  return json({ ok: true, data: { id: r.result.id } })
}

function preparedReceipt(userId: number, card: NonNullable<ReturnType<typeof parseCard>>, photoUrl: string | null = null) {
  return {
    user_id: userId,
    result: photoUrl
      // Rasm + matn: chek rasmi, izohda chiroyli matn (Telegram izohi ≤1024 belgi).
      ? { type: 'photo', id: randomId(8), photo_url: photoUrl, thumbnail_url: photoUrl, title: card.title, description: `${card.total.label}: ${card.total.value}`, caption: cardHtml(card, 1000), parse_mode: 'HTML' }
      : {
        type: 'article',
        id: randomId(8),
        title: card.title,
        description: `${card.total.label}: ${card.total.value}`,
        input_message_content: { message_text: cardHtml(card), parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
      },
    allow_user_chats: true,
    allow_group_chats: true,
    allow_bot_chats: false,
    allow_channel_chats: false,
  }
}

async function handleStaff(req: Request, env: Env, action: string): Promise<Response> {
  const s = await authed(req, env)
  if (!s) return fail(401, 'cloud.errors.sessionExpired')
  const owner = await ownerMember(env, s)
  if (!owner) return fail(403, 'cloud.errors.forbidden')
  const now = new Date()
  // Asosiy ega — do'konni ochgan (tenants.owner_uid). Ikkinchi egalarni faqat u qo'shadi va o'chiradi.
  const primary = owner.tenant.owner_uid === s.u
  if (action === 'list') {
    const [members, invites] = await Promise.all([listMembers(env.DB, s.t), listInvites(env.DB, s.t, now)])
    const rows = members.map(({ uid, name, username, role, active, created_at }) => ({ uid, name, username, role, active, created_at, primary: uid === owner.tenant.owner_uid }))
    return json({ ok: true, data: { members: rows, invites, canManageOwners: primary } })
  }
  if (action === 'invite') {
    const body = await readJson(req)
    const role = body?.role ?? 'cashier'
    if (role !== 'cashier' && role !== 'owner') return fail(400, 'cloud.errors.invalidInput', { field: 'role' })
    if (role === 'owner' && !primary) return fail(403, 'cloud.errors.forbidden')
    const inv = await createInvite(env.DB, s.t, s.u, now, role)
    return json({ ok: true, data: { link: `https://t.me/${env.BOT_USERNAME}?start=inv_${inv.token}`, expiresAt: inv.expiresAt, role } })
  }
  if (action === 'revoke-invites') {
    return json({ ok: true, data: { revoked: await revokeInvites(env.DB, s.t, now) } })
  }
  if (action === 'set-active') {
    const body = await readJson(req)
    const uid = body?.uid
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || typeof body?.active !== 'boolean') return fail(400, 'cloud.errors.invalidInput', { field: 'uid' })
    if (uid === s.u) return fail(403, 'cloud.errors.forbidden')
    const m = await setMemberActive(env.DB, s.t, uid, body.active, primary)
    if (!m) return fail(404, 'cloud.errors.notFound', { what: 'member' })
    await shop(env, s.t).syncMember({ uid: m.uid, name: m.name, role: m.role, active: !!m.active })
    return json({ ok: true, data: null })
  }
  return fail(404, 'cloud.errors.notFound', { what: 'route' })
}

/** Platforma admini (ilovadagi Admin sahifasi): barcha do'konlar, obunani uzaytirish, bloklash.
 *  Huquq — sessiya uid'i `ADMIN_CHAT_ID` da (bot buyruqlari bilan bir xil manba). */
async function handleAdmin(req: Request, env: Env, action: string): Promise<Response> {
  const s = await authed(req, env)
  if (!s) return fail(401, 'cloud.errors.sessionExpired')
  if (action === 'exit') {
    // Ko'rishdan chiqish — adminning O'Z do'koni (oxirgi tanlangan). Admin huquqi shart emas: faqat o'z a'zoligi beriladi.
    if (s.v !== 1) return fail(400, 'cloud.errors.invalidInput', { field: 'session' })
    const m = await defaultMembership(env.DB, s.u)
    if (!m || !m.active) return fail(401, 'cloud.errors.sessionExpired')
    return sessionResponse(env, m)
  }
  if (!isAdminUid(env.ADMIN_CHAT_ID, s.u)) return fail(403, 'cloud.errors.forbidden')
  const now = new Date().toISOString()
  const view = (t: Awaited<ReturnType<typeof listTenants>>[number]) => ({
    id: t.id, name: t.name, owner_uid: t.owner_uid, owner_username: t.owner_username ?? null, members: t.members ?? 0,
    trial_until: t.trial_until, paid_until: t.paid_until, created_at: t.created_at,
    state: tenantState(t, now), until: tenantUntil(t), own: t.id === s.t, ai: t.ai_enabled !== 0,
  })
  if (action === 'tenants') {
    return json({ ok: true, data: (await listTenants(env.DB, 500)).map(view) })
  }
  if (action === 'funnel' || action === 'nudges') {
    const body = await readJson(req)
    if (action === 'nudges') {
      if (typeof body?.enabled !== 'boolean') return fail(400, 'cloud.errors.invalidInput', { field: 'enabled' })
      await setNudgesEnabled(env.DB, body.enabled)
    }
    const days = body?.days === undefined ? 30 : Number(body.days)
    if (!Number.isSafeInteger(days) || days < 0 || days > 3650) return fail(400, 'cloud.errors.invalidInput', { field: 'days' })
    return json({ ok: true, data: await funnelReport(env, days, new Date()) })
  }
  const body = await readJson(req)
  const id = typeof body?.id === 'string' && /^[a-f0-9]{32}$/.test(body.id) ? body.id : null
  if (!id) return fail(400, 'cloud.errors.invalidInput', { field: 'id' })
  const t = await findTenant(env.DB, id)
  if (!t) return fail(404, 'cloud.errors.notFound', { what: 'tenant' })
  if (action === 'view') {
    console.log(JSON.stringify({ evt: 'admin_view', admin: s.u, tenant: t.id }))
    return viewResponse(env, t, { uid: s.u, name: s.n }, Math.min(s.abs, nowSec() + VIEW_ABSOLUTE))
  }
  if (action === 'extend') {
    const day = typeof body?.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.until) ? body.until : null
    if (!day || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return fail(400, 'cloud.errors.invalidInput', { field: 'until' })
    const until = endOfTashkentDay(day)
    await syncSubscriptions(env, await setPaidUntil(env.DB, t.id, until))
  } else if (action === 'status') {
    const status = body?.status
    if (status !== 'active' && status !== 'blocked') return fail(400, 'cloud.errors.invalidInput', { field: 'status' })
    // O'z do'konini bloklasa — admin o'zi ham yoza olmay qoladi; bunga yo'l qo'yilmaydi.
    const own = await findTenant(env.DB, s.t)
    if (status === 'blocked' && (t.id === s.t || t.group_id === own?.group_id)) return fail(409, 'cloud.admin.errors.ownShop')
    await syncSubscriptions(env, await setTenantStatus(env.DB, t.id, status))
  } else if (action === 'ai') {
    if (typeof body?.enabled !== 'boolean') return fail(400, 'cloud.errors.invalidInput', { field: 'enabled' })
    // Avval do'kon (darhol amal qiladi), keyin ro'yxat — yarim holatda AI yoqilgan qolib ketmasin.
    await shop(env, t.id).setAiEnabled(body.enabled)
    await setTenantAi(env.DB, t.id, body.enabled)
  } else {
    return fail(404, 'cloud.errors.notFound', { what: 'route' })
  }
  const row = (await listTenants(env.DB, 500)).find((x) => x.id === t.id)
  return json({ ok: true, data: row ? view(row) : null })
}

async function handleWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? ''
  if (!env.TG_WEBHOOK_SECRET || !timingSafeEqual(secret, env.TG_WEBHOOK_SECRET)) return new Response('Forbidden', { status: 403 })
  const update = await readJson(req)
  if (update) ctx.waitUntil(handleUpdate(env, update).catch((e) => console.error('webhook:', e)))
  return new Response('ok')
}

// ---------------------------------------------------------------------------
// AI yordamchisi: matn yoki ovoz → qoralama → (tuzatish) → tasdiqlash. Yozish faqat apply'da.

const MAX_AUDIO_BYTES = 2_000_000
const DRAFT_ID = /^[a-f0-9]{16}$/

/** Ilova chatidagi bitta xabar juftligi: foydalanuvchi (matn/ovoz) + yordamchi (javob matni yoki botdagidek karta). */
async function chatItem(env: Env, tenantId: string, e: ChatEntry, l: Lang) {
  const d = e.draft
  // Bitta xabarning keyingi amali (partOf) — foydalanuvchi xabari birinchi kartada ko'rsatilgan.
  const user = d.partOf ? null : { kind: e.voice ? 'voice' : 'text', text: d.transcript, voice: e.voice }
  if (chatOnly(d)) return { id: d.id, at: e.at, user, reply: { kind: 'text', text: d.question ?? '' } }
  const open = d.status === 'new' && !e.expired
  const withRate = open ? await withFx(env, tenantId, d) : d
  const status = e.expired ? 'expired' : d.status === 'new' ? 'open' : d.status === 'applied' ? 'saved' : d.replacedBy ? 'replaced' : 'cancelled'
  // Faqat valyuta to'sig'i qolgan — kurs bilan saqlash tugmasi (botdagidek).
  const convert = open && !d.ready && withRate.fx && d.issues.every((i) => i.code === 'currencyMismatch') ? withRate.fx.rate : null
  return { id: d.id, at: e.at, user, reply: { kind: 'card', html: draftCardHtml(withRate, l, e.expired), status, ready: open && d.ready, convert, kindName: d.kind } }
}
const langOfBody = (b: Record<string, unknown> | null): Lang => (b?.lang === 'ru' ? 'ru' : 'uz')

/** Ovoz ko'rinishi sarlavhadan (X-Voice: {"ms":…,"wave":[…]}) — faqat raqamlar, chegaralangan. */
function voiceMeta(raw: string | null) {
  try {
    const o = JSON.parse(raw ?? '') as { ms?: unknown; wave?: unknown }
    const ms = typeof o.ms === 'number' && o.ms > 0 && o.ms < 600_000 ? Math.round(o.ms) : 0
    const wave = Array.isArray(o.wave) ? o.wave.slice(0, 64).map((x) => (typeof x === 'number' && x >= 0 && x <= 1 ? Math.round(x * 100) / 100 : 0)) : []
    return ms ? { ms, wave } : null
  } catch { return null }
}

async function handleAssistant(req: Request, env: Env, ctx: ExecutionContext, action: string): Promise<Response> {
  const s = await authed(req, env)
  if (!s) return fail(401, 'cloud.errors.sessionExpired')
  const actor = actorOf(s)
  const shop = env.SHOP.getByName(s.t)
  if (action === 'parse') {
    const type = req.headers.get('Content-Type') ?? ''
    let input: { text?: string; audio?: Uint8Array; mime?: string }
    // Ilova chati: X-Chat-Id (ovoz) yoki body.chatId (matn); bo'sh — yangi chat. Bo'lmasa — eski (chatsiz) rejim.
    let chat: { id: string | null; voice: ReturnType<typeof voiceMeta> } | null = null
    let lang: Lang = 'uz'
    if (type.startsWith('audio/') || type.startsWith('video/') || type === 'application/octet-stream') {
      const hid = req.headers.get('X-Chat-Id')
      if (hid !== null) chat = { id: DRAFT_ID.test(hid) ? hid : null, voice: voiceMeta(req.headers.get('X-Voice')) }
      lang = req.headers.get('X-Lang') === 'ru' ? 'ru' : 'uz'
      const len = Number(req.headers.get('Content-Length') ?? '0')
      if (len > MAX_AUDIO_BYTES) return fail(413, 'cloud.ai.errors.audioTooLong')
      const bytes = new Uint8Array(await req.arrayBuffer())
      if (bytes.byteLength > MAX_AUDIO_BYTES) return fail(413, 'cloud.ai.errors.audioTooLong')
      input = { audio: bytes, mime: type.split(';')[0] }
    } else {
      const body = await readJson(req)
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (!text) return fail(400, 'cloud.errors.invalidInput', { field: 'text' })
      input = { text }
      if (body && 'chatId' in body) chat = { id: typeof body.chatId === 'string' && DRAFT_ID.test(body.chatId) ? body.chatId : null, voice: null }
      lang = langOfBody(body)
    }
    const r = await runAssistant(env, s.t, actor, input, input.audio ? 'voice' : 'text', chat, lang)
    if (!r.ok) return fail(r.status, r.code)
    if (r.draft.replaces) await markReplaced(env, s.t, actor, r.draft.replaces).catch(() => undefined)
    const data = await withFx(env, s.t, r.draft)
    // Bir xabarda bir nechta amal — keyingilari `more` da (chatda: foydalanuvchi pufagisiz kartalar).
    if (!chat) return json({ ok: true, data: { ...data, more: await Promise.all(r.more.map((d) => withFx(env, s.t, d))) } })
    const item = await chatItem(env, s.t, { draft: r.draft, at: r.draft.createdAt, voice: chat.voice, expired: false }, lang)
    const more = await Promise.all(r.more.map((d) => chatItem(env, s.t, { draft: d, at: d.createdAt, voice: null, expired: false }, lang)))
    return json({ ok: true, data: { ...data, item, more } })
  }
  if (action === 'chats') {
    return json({ ok: true, data: (await shop.assistantChats(actor)) ?? [] })
  }
  if (action === 'chat' || action === 'chat-delete') {
    const body = await readJson(req)
    const id = typeof body?.id === 'string' && DRAFT_ID.test(body.id) ? body.id : null
    if (!id) return fail(400, 'cloud.errors.invalidInput', { field: 'id' })
    if (action === 'chat-delete') return (await shop.assistantChatDelete(actor, id)) ? json({ ok: true, data: null }) : fail(404, 'cloud.ai.errors.chatGone')
    const entries = (await shop.assistantChat(actor, id)) as ChatEntry[] | null
    if (!entries) return fail(404, 'cloud.ai.errors.chatGone')
    const l = langOfBody(body)
    return json({ ok: true, data: await Promise.all(entries.map((e) => chatItem(env, s.t, e, l))) })
  }
  const body = await readJson(req)
  const id = typeof body?.id === 'string' && DRAFT_ID.test(body.id) ? body.id : null
  if (!id) return fail(400, 'cloud.errors.invalidInput', { field: 'id' })
  if (action === 'get' || action === 'update' || action === 'cancel') {
    const d = (action === 'get' ? await shop.assistantGet(actor, id)
      : action === 'update' ? await shop.assistantUpdate(actor, id, cleanEdits(body?.edits))
      : await shop.assistantCancel(actor, id)) as Draft | null
    return d ? json({ ok: true, data: await withFx(env, s.t, d) }) : fail(404, 'cloud.ai.errors.draftGone')
  }
  if (action === 'apply') {
    const r = (await shop.assistantApply(actor, id, body?.edits ? cleanEdits(body.edits) : null)) as ApplyOutcome
    // Yordamchi tovar yaratishi yoki kirimda narx o'zgartirishi mumkin — filiallarga.
    if (r.ok) ctx.waitUntil(syncBranchesOf(env, s.t))
    if (r.ok) return json({ ok: true, data: r.draft })
    return json({ ok: false, error: r.error, draft: await withFx(env, s.t, r.draft) }, r.error.status)
  }
  return fail(404, 'cloud.errors.notFound', { what: 'route' })
}

/**
 * Bot sozlash (deploydan keyin bir marta): webhook (✅/❌ uchun callback_query bilan), menyu tugmasi
 * (web_app → APP_URL), buyruqlar. Token Worker sirida qoladi — chaqiruvchi uni bilmaydi; himoya —
 * `X-Setup-Key` = TG_WEBHOOK_SECRET. Javobda sir yo'q, faqat holat.
 */
async function handleSetup(req: Request, env: Env): Promise<Response> {
  const key = req.headers.get('X-Setup-Key') ?? ''
  if (!env.TG_WEBHOOK_SECRET || !timingSafeEqual(key, env.TG_WEBHOOK_SECRET)) return new Response('Forbidden', { status: 403 })
  const body = await readJson(req)
  const app = env.APP_URL.replace(/\/+$/, '')
  const me = await tgCall<{ username: string }>(env, 'getMe', {})
  const hook = await tgCall(env, 'setWebhook', {
    url: `${app}/tg/webhook`,
    secret_token: env.TG_WEBHOOK_SECRET,
    // widget_query — HTML widget kartalari (Bot API 10.4); ro'yxatda bo'lmasa karta tugmalari jim ishlamaydi.
    allowed_updates: ['message', 'callback_query', 'widget_query'],
    max_connections: 40,
  })
  const menu = await tgCall(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Kassa', web_app: { url: `${app}/` } } })
  const cmds = await tgCall(env, 'setMyCommands', { commands: [{ command: 'start', description: 'Kassani ochish' }, { command: 'hisobot', description: 'Savdo kartasi (egaga)' }, { command: 'dokon', description: "Yordamchi uchun do'konni tanlash" }] })
  const cmdsRu = await tgCall(env, 'setMyCommands', { commands: [{ command: 'start', description: 'Открыть кассу' }, { command: 'hisobot', description: 'Карточка продаж (владельцу)' }, { command: 'dokon', description: 'Выбрать магазин для помощника' }], language_code: 'ru' })
  // Admin chatida — admin buyruqlari ham menyuda (boshqalarga ko'rinmaydi).
  const adminCmds = await Promise.all((env.ADMIN_CHAT_ID ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((chat) => tgCall(env, 'setMyCommands', {
    scope: { type: 'chat', chat_id: Number(chat) },
    commands: [
      { command: 'start', description: 'Kassani ochish' },
      { command: 'hisobot', description: 'Savdo kartasi (egaga)' },
      { command: 'dokon', description: "Yordamchi uchun do'konni tanlash" },
      { command: 'admin', description: 'Admin paneli (ilovada)' },
      { command: 'tenants', description: "Do'konlar ro'yxati" },
      { command: 'varonka', description: '[1|7|30|0] — varonka (jonli karta)' },
      { command: 'extend', description: '<id> YYYY-MM-DD — obunani uzaytirish' },
      { command: 'block', description: "<id> — do'konni bloklash" },
      { command: 'unblock', description: '<id> — blokdan chiqarish' },
    ],
  })))
  // Profil: description + about har safar; logo faqat so'ralganda (`{"photo": true}`) — har deployda qayta yuklanmasin.
  const profile = await applyProfile(env, { photo: body?.photo === true })
  const info = await tgCall<{ url: string; pending_update_count: number; last_error_message?: string; allowed_updates?: string[] }>(env, 'getWebhookInfo', {})
  return json({
    ok: me.ok && hook.ok && menu.ok && cmds.ok && cmdsRu.ok && adminCmds.every((r) => r.ok) && profile.texts && profile.photo !== false,
    bot: me.ok ? me.result?.username ?? null : null,
    botUsernameMatches: me.ok && !!me.result?.username && me.result.username.toLowerCase() === env.BOT_USERNAME.toLowerCase(),
    webhook: info.ok && info.result ? { url: info.result.url, pending: info.result.pending_update_count, allowed: info.result.allowed_updates ?? null, lastError: info.result.last_error_message ?? null } : null,
    steps: { getMe: me.ok, setWebhook: hook.ok, menu: menu.ok, commands: cmds.ok && cmdsRu.ok, adminCommands: adminCmds.length ? adminCmds.every((r) => r.ok) : null, profileTexts: profile.texts, profilePhoto: profile.photo },
  })
}

/** AI tekshiruvi (admin, `X-Setup-Key`): Gemini kaliti/modeli/regioni ishlaydimi — sinov so'rovi + mavjud flash modellar. */
/** Asoschi xabari (admin, `X-Setup-Key`): ro'yxatdagi odamga bot orqali bitta xabar — bir martalik (funnel.ts). */
async function handleOutreach(req: Request, env: Env): Promise<Response> {
  const key = req.headers.get('X-Setup-Key') ?? ''
  if (!env.TG_WEBHOOK_SECRET || !timingSafeEqual(key, env.TG_WEBHOOK_SECRET)) return new Response('Forbidden', { status: 403 })
  const o = parseOutreach(await readJson(req))
  if (typeof o === 'string') return fail(400, 'cloud.errors.invalidInput', { field: o })
  const r = await sendOutreach(env, o, new Date())
  if (!r) return fail(404, 'cloud.errors.notFound', { what: 'user' })
  console.log(JSON.stringify({ evt: 'outreach', uid: o.uid, key: o.key, status: r.status }))
  return json({ ok: true, data: r })
}

/**
 * Asoschi xabariga botning o'ziga yozilgan javoblarni tiklash (relay ishga tushgunga qadar AI'ga ketganlar).
 * Faqat setup kaliti bilan; faqat `since` dan keyin asoschi xabari (manual:*) yetgan odamlar; faqat bot chati.
 */
async function handleReplies(req: Request, env: Env): Promise<Response> {
  const key = req.headers.get('X-Setup-Key') ?? ''
  if (!env.TG_WEBHOOK_SECRET || !timingSafeEqual(key, env.TG_WEBHOOK_SECRET)) return new Response('Forbidden', { status: 403 })
  const body = await readJson(req)
  const since = typeof body?.since === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(body.since) ? body.since : null
  if (!since) return fail(400, 'cloud.errors.invalidInput', { field: 'since' })
  const people = (await env.DB.prepare(
    `SELECT DISTINCT n.uid, f.username, f.name FROM nudges n LEFT JOIN funnel_users f ON f.uid = n.uid
     WHERE n.kind LIKE 'manual:%' AND n.status = 'sent' AND n.at >= ? LIMIT 50`,
  ).bind(since).all<{ uid: number; username: string | null; name: string | null }>()).results
  const out = await Promise.all(people.map(async (p) => {
    const m = await defaultMembership(env.DB, p.uid)
    if (!m) return { ...p, shop: null, messages: [] }
    const messages = await shop(env, m.tenant_id).botTranscripts(p.uid, since).catch(() => [])
    return { ...p, shop: m.tenant.name, messages }
  }))
  return json({ ok: true, data: out })
}

async function handleAiCheck(req: Request, env: Env): Promise<Response> {
  const key = req.headers.get('X-Setup-Key') ?? ''
  if (!env.TG_WEBHOOK_SECRET || !timingSafeEqual(key, env.TG_WEBHOOK_SECRET)) return new Response('Forbidden', { status: 403 })
  const body = await readJson(req)
  const model = (typeof body?.model === 'string' && /^[a-z0-9.-]{3,60}$/.test(body.model) ? body.model : '') || env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
  const out: Record<string, unknown> = { geminiKey: !!env.GEMINI_API_KEY, model, workersAi: !!env.AI }
  if (body?.fx) out.cbu = (await cbuRates())?.USD ?? null
  // Chek ulashish (savePreparedInlineMessage) shu botda ishlaydimi — admin uchun sinov xabari tayyorlanadi.
  if (body?.prep) {
    const uid = Number((env.ADMIN_CHAT_ID ?? '').split(',')[0])
    const card = parseCard({ shop: 'Test', title: 'Chek #0', meta: 'sinov', items: [{ name: 'Tovar', line: '1 × 1 000', sum: "1 000 so'm" }], total: { label: 'Jami', value: "1 000 so'm" }, rows: [], foot: null })!
    const photo = body.prep === 'photo' ? `${env.APP_URL.replace(/\/+$/, '')}/bot-logo.jpg` : null
    const r = uid ? await tgCall<{ id: string }>(env, 'savePreparedInlineMessage', preparedReceipt(uid, card, photo)) : null
    out.prepared = r ? (r.ok ? { ok: true } : { ok: false, status: r.status, description: r.description }) : 'no admin uid'
  }
  if (env.GEMINI_API_KEY) {
    if (body?.list) {
      const lm = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } }).catch(() => null)
      const list = (await lm?.json().catch(() => null)) as { models?: { name: string }[]; error?: { message?: string } } | null
      out.models = list?.models?.map((m) => m.name.replace('models/', '')).filter((n) => /flash|pro/.test(n)).slice(0, 40) ?? list?.error?.message ?? null
    }
    const t0 = Date.now()
    // Sinov ssenariysi: matn yoki ovoz + ixtiyoriy oldingi xabarlar (kontekst/tuzatishlarni tekshirish uchun).
    const history = Array.isArray(body?.history)
      ? (body.history as unknown[]).slice(-12).flatMap((x) => {
        const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
        return (r.role === 'user' || r.role === 'assistant') && typeof r.text === 'string' ? [{ role: r.role as 'user' | 'assistant', text: r.text.slice(0, 1500) }] : []
      })
      : []
    const products = Array.isArray(body?.products) ? (body.products as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 80) : ['Samsung 25W zaryadka']
    try {
      const g = await geminiAssist({
        key: env.GEMINI_API_KEY, model, history,
        ...(typeof body?.audio === 'string' && body.audio.length < 3_000_000
          ? { audio: { bytes: Uint8Array.from(atob(body.audio), (c) => c.charCodeAt(0)), mime: typeof body.mime === 'string' ? body.mime : 'audio/ogg' } }
          : { text: typeof body?.text === 'string' && body.text.trim() ? body.text.slice(0, 1500) : 'Bahromga 2 ta Samsung zaryadka qarzga' }),
        hints: { shopName: 'Test', currency: "so'm", products, customers: ["Bahrom do'kon"] },
      })
      out.gemini = { ok: true, ms: Date.now() - t0, transcript: g.transcript, extraction: g.extraction }
    } catch (e) {
      out.gemini = { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return json(out)
}

export async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const p = url.pathname
  if (req.method === 'POST') {
    if (p.startsWith('/api/')) {
      const denied = await viewGuard(req, env, p)
      if (denied) return denied
    }
    if (p === '/api/session') return handleSession(req, env, ctx)
    if (p === '/api/onboard') return handleOnboard(req, env, ctx)
    if (p === '/api/write-access') return handleWriteAccess(req, env)
    if (p === '/api/session/refresh') return handleRefresh(req, env)
    if (p === '/api/session/switch') return handleSwitch(req, env)
    if (p === '/api/shops/create') return handleCreateShop(req, env, ctx)
    if (p.startsWith('/api/transfers/')) return handleTransfers(req, env, p.slice('/api/transfers/'.length))
    if (p === '/api/group/report') return handleGroupReport(req, env)
    if (p.startsWith('/api/rpc/')) return handleRpc(req, env, ctx, p.slice('/api/rpc/'.length))
    if (p === '/api/export') return handleExport(req, env)
    if (p === '/api/receipt') return handleReceipt(req, env)
    if (p.startsWith('/api/staff/')) return handleStaff(req, env, p.slice('/api/staff/'.length))
    if (p.startsWith('/api/assistant/')) return handleAssistant(req, env, ctx, p.slice('/api/assistant/'.length))
    if (p.startsWith('/api/admin/')) return handleAdmin(req, env, p.slice('/api/admin/'.length))
    if (p === '/tg/webhook') return handleWebhook(req, env, ctx)
    if (p === '/tg/setup') return handleSetup(req, env)
    if (p === '/tg/ai-check') return handleAiCheck(req, env)
    if (p === '/tg/outreach') return handleOutreach(req, env)
    if (p === '/tg/replies') return handleReplies(req, env)
  }
  if (req.method === 'GET') {
    const ri = /^\/rimg\/([a-f0-9]{32})\/([a-f0-9]{32})\.jpg$/.exec(p)
    if (ri) {
      if (!(await findTenant(env.DB, ri[1]))) return new Response('Not found', { status: 404 })
      const data = await shop(env, ri[1]).getReceiptImage(ri[2])
      return data
        ? new Response(data, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } })
        : new Response('Not found', { status: 404 })
    }
    const m = /^\/img\/([a-f0-9]{32})\/(\d{1,12})\/(v[a-f0-9]{12})$/.exec(p)
    if (m) return handleImage(req, env, ctx, m[1], Number(m[2]), m[3])
  }
  if (p.startsWith('/api/') || p.startsWith('/tg/') || p.startsWith('/img/') || p.startsWith('/rimg/')) return fail(404, 'cloud.errors.notFound', { what: 'route' })
  return env.ASSETS.fetch(req)
}

export default {
  // Har 15 daqiqa: varonka (do'konlar holati) + avtomatik eslatmalar (admin yoqqan bo'lsa).
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runFunnelCron(env, new Date(), trialDays(env.TRIAL_DAYS))
      .then((r) => console.log(JSON.stringify({ evt: 'funnel_cron', ...r })), (e) => console.error('funnel cron:', e)))
  },
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(req, env, ctx)
    } catch (e) {
      console.error('unhandled:', e instanceof Error ? e.stack : e)
      return fail(500, 'cloud.errors.internal')
    }
  },
} satisfies ExportedHandler<Env>
