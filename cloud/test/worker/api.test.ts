import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { route } from '../../src/index'
import { signInitData, verifyInitData } from '../../src/auth/initData'
import { signSession, verifySession } from '../../src/auth/session'

// Telegram API chaqiruvlari ushlanadi (tashqi tarmoq yo'q).
type TgCall = { method: string; body: any }
let tgCalls: TgCall[] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  tgCalls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://tg.mock/')) {
      const method = url.split('/').pop()!
      const body = init?.body instanceof FormData ? Object.fromEntries(init.body as any) : JSON.parse(String(init?.body ?? '{}'))
      tgCalls.push({ method, body })
      if (method === 'savePreparedInlineMessage') return Response.json({ ok: true, result: { id: 'prep-1', expiration_date: 1 } })
      return Response.json({ ok: true, result: { message_id: 1 } })
    }
    return realFetch(input as RequestInfo, init)
  })
})
afterEach(() => { vi.restoreAllMocks() })

async function call(path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  let body: BodyInit | undefined
  if (init.body instanceof ArrayBuffer || init.body instanceof Uint8Array) body = init.body as BodyInit
  else if (init.body !== undefined) { body = JSON.stringify(init.body); headers['Content-Type'] = 'application/json' }
  const res = await route(new Request(`https://kassa.test${path}`, { method: init.method ?? 'POST', headers, body }), env, ctx)
  await Promise.all(pending)
  const isJson = (res.headers.get('Content-Type') ?? '').includes('json')
  const bytes = await res.arrayBuffer()
  const text = isJson ? new TextDecoder().decode(bytes) : ''
  let json: any = null
  if (isJson) { try { json = JSON.parse(text) } catch { /* bo'sh */ } }
  return { status: res.status, json, res, text, bytes }
}

let nextUid = 5_000_000
function tgUser(name = 'Shahbozbek', username?: string) {
  return { id: ++nextUid, first_name: name, username, language_code: 'uz' }
}

async function initData(user: { id: number }, extra: Record<string, string> = {}, authDate = Math.floor(Date.now() / 1000)) {
  return signInitData({ auth_date: String(authDate), query_id: 'AAE', user: JSON.stringify(user), ...extra }, env.BOT_TOKEN)
}

async function onboard(name = 'Suv savdo', user = tgUser()) {
  const r = await call('/api/onboard', { body: { initData: await initData(user), shopName: name } })
  expect(r.status).toBe(200)
  return { user, token: r.json.token as string, shopId: r.json.shop.id as string, json: r.json }
}

const rpc = (token: string, op: string, args: unknown[] = [], key?: string) =>
  call(`/api/rpc/${op}`, { token, body: { args }, headers: key ? { 'Idempotency-Key': key } : {} })

describe('initData', () => {
  it('accepts a valid signature and rejects tampering, age, wrong bot', async () => {
    const u = tgUser()
    const now = Math.floor(Date.now() / 1000)
    const good = await initData(u, { start_param: 'inv_x' })
    expect(await verifyInitData(good, env.BOT_TOKEN, now)).toMatchObject({ user: { id: u.id }, startParam: 'inv_x' })
    expect(await verifyInitData(good.replace('Shahbozbek', 'Hacker'), env.BOT_TOKEN, now)).toBeNull()
    expect(await verifyInitData(good, '999:other-bot', now)).toBeNull()
    expect(await verifyInitData(await initData(u, {}, now - 90_000), env.BOT_TOKEN, now)).toBeNull()
    expect(await verifyInitData(await initData(u, {}, now + 3600), env.BOT_TOKEN, now)).toBeNull()
    expect(await verifyInitData('', env.BOT_TOKEN, now)).toBeNull()
  })
})

describe('session token', () => {
  it('expires after TTL but can be refreshed until the absolute limit', async () => {
    const now = 1_800_000_000
    const t = await signSession({ t: 'a'.repeat(32), u: 1, r: 'owner', n: 'X' }, env.SESSION_KEY, now)
    expect(await verifySession(t, env.SESSION_KEY, now + 60)).toMatchObject({ u: 1, r: 'owner' })
    expect(await verifySession(t, env.SESSION_KEY, now + 13 * 3600)).toBeNull()
    expect(await verifySession(t, env.SESSION_KEY, now + 13 * 3600, { allowExpired: true })).not.toBeNull()
    expect(await verifySession(t, env.SESSION_KEY, now + 31 * 86400, { allowExpired: true })).toBeNull()
    const [v, body, sig] = t.split('.')
    const forged = btoa(JSON.stringify({ ...JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))), r: 'owner', t: 'b'.repeat(32) })).replace(/=+$/, '')
    expect(await verifySession(`${v}.${forged}.${sig}`, env.SESSION_KEY, now)).toBeNull()
  })
})

describe('onboarding and session', () => {
  it('new user → onboard → owner with 7-day trial; repeat onboard returns same shop', async () => {
    const user = tgUser('Zafar', 'muzaffaryat')
    const s1 = await call('/api/session', { body: { initData: await initData(user) } })
    expect(s1.json).toMatchObject({ ok: true, status: 'new', user: { uid: user.id } })

    const a = await onboard('Zafar aksessuar', user)
    expect(a.json).toMatchObject({ status: 'ok', user: { role: 'owner', name: 'Zafar' }, shop: { name: 'Zafar aksessuar' }, member: { role: 'owner' }, subscription: { active: true }, settings: { currency_symbol: "so'm", shop_name: 'Zafar aksessuar' }, shift: null })
    const trialDays = (Date.parse(a.json.subscription.trialUntil) - Date.now()) / 86400_000
    expect(trialDays).toBeGreaterThan(6.9)
    expect(trialDays).toBeLessThanOrEqual(7)
    expect(tgCalls.find((c) => c.method === 'sendMessage' && c.body.chat_id === '777')?.body.text).toContain('Zafar aksessuar')

    tgCalls = []
    const b = await onboard('Boshqa nom', user)
    expect(b.shopId).toBe(a.shopId)
    expect(tgCalls).toHaveLength(0) // admin ikkinchi marta xabar olmaydi
    const s2 = await call('/api/session', { body: { initData: await initData(user) } })
    expect(s2.json).toMatchObject({ status: 'ok', shop: { id: a.shopId } })
  })

  it('rejects bad initData and bad shop names', async () => {
    expect((await call('/api/session', { body: { initData: 'user=%7B%7D&hash=00' } })).status).toBe(401)
    const u = tgUser()
    expect((await call('/api/onboard', { body: { initData: await initData(u), shopName: 'x' } })).status).toBe(400)
  })

  it('refresh issues a new token while membership is active', async () => {
    const a = await onboard()
    const r = await call('/api/session/refresh', { token: a.token })
    expect(r.status).toBe(200)
    expect(r.json.token).toBeTypeOf('string')
    expect((await call('/api/session/refresh', { token: 'v1.bad.sig' })).status).toBe(401)
  })
})

describe('rpc over HTTP', () => {
  it('requires a valid token and known op', async () => {
    const a = await onboard()
    expect((await rpc('', 'listProducts')).status).toBe(401)
    expect((await rpc(a.token + 'x', 'listProducts')).status).toBe(401)
    expect((await rpc(a.token, 'nope')).json).toMatchObject({ ok: false, error: { code: 'cloud.errors.unknownOp' } })
    expect((await rpc(a.token, '../admin')).status).toBe(404)
  })

  it('idempotent sale: retry with the same key creates one receipt', async () => {
    const a = await onboard()
    const pid = (await rpc(a.token, 'saveProduct', [{ name: 'Suv 19L', price: 15000, cost_price: 9000 }])).json.data
    await runInDurableObject(env.SHOP.get(env.SHOP.idFromName(a.shopId)), (_i, state) => {
      state.storage.sql.exec('UPDATE products SET stock = 100 WHERE id = ?', pid)
    })
    const shift = (await rpc(a.token, 'openShift', [0])).json.data
    const walkIn = (await rpc(a.token, 'listCustomers', [])).json.data[0]
    const sale = [{ shiftId: shift.id, customerId: walkIn.id, items: [{ product_id: pid, qty: 2, price: 15000 }], paidCash: 30000, paidCard: 0, discount: 0 }]
    const r1 = await rpc(a.token, 'createSale', sale, 'k-0123456789')
    const r2 = await rpc(a.token, 'createSale', sale, 'k-0123456789')
    expect(r1.json.data.receipt_number).toBe(`${shift.id}-00001`)
    expect(r2.json).toMatchObject({ ok: true, replayed: true, data: { id: r1.json.data.id } })
    expect((await rpc(a.token, 'listSales', [{}])).json.data).toHaveLength(1)
    expect((await rpc(a.token, 'listProducts', [])).json.data[0].stock).toBe(98)
  })

  it('tenants are isolated', async () => {
    const a = await onboard('A do\'kon')
    const b = await onboard('B do\'kon')
    await rpc(a.token, 'saveProduct', [{ name: 'Faqat A', price: 1 }])
    expect((await rpc(b.token, 'listProducts', [])).json.data).toEqual([])
    expect((await rpc(a.token, 'listProducts', [])).json.data.map((p: any) => p.name)).toEqual(['Faqat A'])
  })
})

describe('staff (cashier) invites', () => {
  it('invite → cashier joins → restricted → revoked immediately', async () => {
    const owner = await onboard('Kassirli do\'kon')
    const inv = await call('/api/staff/invite', { token: owner.token })
    const link: string = inv.json.data.link
    expect(link).toMatch(new RegExp(`^https://t\\.me/${env.BOT_USERNAME}\\?start=inv_[a-f0-9]{32}$`))
    const token = link.split('inv_')[1]

    const cashierUser = tgUser('Kassir Ali')
    const s = await call('/api/session', { body: { initData: await initData(cashierUser), invite: token } })
    expect(s.json).toMatchObject({ status: 'ok', user: { role: 'cashier' }, shop: { id: owner.shopId } })
    expect(tgCalls.some((c) => c.body.chat_id === owner.user.id && /kassir/.test(c.body.text))).toBe(true)
    const ct = s.json.token as string

    expect((await rpc(ct, 'listProducts', [])).status).toBe(200)
    expect((await rpc(ct, 'reportSummary', ['2026-01-01', '2026-12-31'])).status).toBe(403)
    expect((await call('/api/staff/invite', { token: ct })).status).toBe(403)

    // Taklif bir martalik.
    const other = await call('/api/session', { body: { initData: await initData(tgUser('Begona')), invite: token } })
    expect(other.json).toMatchObject({ ok: false, error: { code: 'cloud.errors.invite.used' } })

    const list = await call('/api/staff/list', { token: owner.token })
    expect(list.json.data.members.map((m: any) => m.role).sort()).toEqual(['cashier', 'owner'])

    await call('/api/staff/set-active', { token: owner.token, body: { uid: cashierUser.id, active: false } })
    // Token hali muddatida, lekin DO'dagi nusxa yangilangan — darhol rad.
    expect((await rpc(ct, 'listProducts', [])).json).toMatchObject({ ok: false, error: { code: 'cloud.errors.memberRevoked' } })
    expect((await call('/api/session', { body: { initData: await initData(cashierUser) } })).status).toBe(403)
    // O'zini (va asosiy egani) o'chirib bo'lmaydi.
    expect((await call('/api/staff/set-active', { token: owner.token, body: { uid: owner.user.id, active: false } })).status).toBe(403)
  })

  it('invite via signed start_param (startapp=inv_...)', async () => {
    const owner = await onboard()
    const token = (await call('/api/staff/invite', { token: owner.token })).json.data.link.split('inv_')[1]
    const u = tgUser('Startapp')
    const s = await call('/api/session', { body: { initData: await initData(u, { start_param: `inv_${token}` }) } })
    expect(s.json).toMatchObject({ status: 'ok', user: { role: 'cashier' } })
  })
})

describe('linking another Telegram account as owner', () => {
  const hook = (text: string, from: number) => call('/tg/webhook', {
    body: { message: { chat: { id: from, type: 'private' }, from: { id: from, language_code: 'uz' }, text } },
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' },
  })

  it('owner invite gives full rights; only the primary owner manages owners', async () => {
    const primary = await onboard("Sherikli do'kon")
    expect((await call('/api/staff/invite', { token: primary.token, body: { role: 'admin' } })).status).toBe(400)
    const inv = await call('/api/staff/invite', { token: primary.token, body: { role: 'owner' } })
    expect(inv.json.data.role).toBe('owner')
    const token = inv.json.data.link.split('inv_')[1]

    // Bot taklif rolini va do'kon nomini aytadi.
    const second = tgUser('Sherik')
    await hook(`/start inv_${token}`, second.id)
    const botMsg = tgCalls.filter((c) => c.method === 'sendMessage').pop()!
    expect(botMsg.body.text).toContain('egasi')
    expect(botMsg.body.text).toContain("Sherikli do'kon")
    expect(botMsg.body.reply_markup.inline_keyboard[0][0].web_app.url).toContain(`?inv=${token}`)

    const s = await call('/api/session', { body: { initData: await initData(second), invite: token } })
    expect(s.json).toMatchObject({ status: 'ok', user: { role: 'owner' }, shop: { id: primary.shopId } })
    expect(tgCalls.some((c) => c.body.chat_id === primary.user.id && /egasi/.test(c.body.text))).toBe(true)
    const co = s.json.token as string

    // To'liq huquq: hisobot va xodimlar ro'yxati ochiq.
    expect((await rpc(co, 'reportSummary', ['2026-01-01', '2026-12-31'])).status).toBe(200)
    const list = await call('/api/staff/list', { token: co })
    expect(list.json.data.canManageOwners).toBe(false)
    expect(list.json.data.members.find((m: any) => m.uid === primary.user.id).primary).toBe(true)

    // Ikkinchi ega: egalik tarqatolmaydi, asosiy egani va o'zini o'chirolmaydi; kassirni boshqaradi.
    expect((await call('/api/staff/invite', { token: co, body: { role: 'owner' } })).status).toBe(403)
    expect((await call('/api/staff/set-active', { token: co, body: { uid: primary.user.id, active: false } })).status).toBe(404)
    expect((await call('/api/staff/set-active', { token: co, body: { uid: second.id, active: false } })).status).toBe(403)
    const cashierInv = (await call('/api/staff/invite', { token: co, body: { role: 'cashier' } })).json.data.link.split('inv_')[1]
    const cashier = tgUser('Kassir Vali')
    expect((await call('/api/session', { body: { initData: await initData(cashier), invite: cashierInv } })).json.user.role).toBe('cashier')
    expect((await call('/api/staff/set-active', { token: co, body: { uid: cashier.id, active: false } })).status).toBe(200)

    // Ishlatilgan havola — bot "ishlamaydi" deydi.
    await hook(`/start inv_${token}`, 99)
    expect(tgCalls.filter((c) => c.method === 'sendMessage').pop()!.body.text).toContain('ishlamaydi')

    // Asosiy ega ikkinchi egani o'chiradi — darhol rad.
    expect((await call('/api/staff/set-active', { token: primary.token, body: { uid: second.id, active: false } })).status).toBe(200)
    expect((await rpc(co, 'listProducts', [])).json).toMatchObject({ ok: false, error: { code: 'cloud.errors.memberRevoked' } })
  })

  it('a cashier opening an owner invite is promoted; an owner is never demoted by an invite', async () => {
    const primary = await onboard()
    const ci = (await call('/api/staff/invite', { token: primary.token })).json.data.link.split('inv_')[1]
    const u = tgUser('Kassirdan ega')
    expect((await call('/api/session', { body: { initData: await initData(u), invite: ci } })).json.user.role).toBe('cashier')
    const oi = (await call('/api/staff/invite', { token: primary.token, body: { role: 'owner' } })).json.data.link.split('inv_')[1]
    const up = await call('/api/session', { body: { initData: await initData(u), invite: oi } })
    expect(up.json.user.role).toBe('owner')
    expect((await rpc(up.json.token, 'reportSummary', ['2026-01-01', '2026-12-31'])).status).toBe(200)
    // Ega kassir havolasini ochsa — o'zgarmaydi.
    const ci2 = (await call('/api/staff/invite', { token: primary.token })).json.data.link.split('inv_')[1]
    expect((await call('/api/session', { body: { initData: await initData(u), invite: ci2 } })).json.user.role).toBe('owner')
  })
})

describe('images', () => {
  it('serves the product image from the DO with immutable caching', async () => {
    const a = await onboard()
    const webp = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'
    await rpc(a.token, 'saveProduct', [{ name: 'Rasm', price: 1, image: webp }])
    const p = (await rpc(a.token, 'listProducts', [])).json.data[0]
    expect(p.image).toMatch(new RegExp(`^/img/${a.shopId}/\\d+/v[0-9a-f]{12}$`))
    const img = await call(p.image, { method: 'GET' })
    expect(img.status).toBe(200)
    expect(img.res.headers.get('Content-Type')).toBe('image/webp')
    expect(img.res.headers.get('Cache-Control')).toContain('immutable')
    expect((await call(`/img/${'f'.repeat(32)}/1/v000000000000`, { method: 'GET' })).status).toBe(404)
  })
})

describe('telegram webhook and admin', () => {
  it('checks the secret and answers /start with a web_app button', async () => {
    const upd = { message: { chat: { id: 42, type: 'private' }, from: { id: 42, language_code: 'ru' }, text: '/start' } }
    expect((await call('/tg/webhook', { body: upd })).status).toBe(403)
    const r = await call('/tg/webhook', { body: upd, headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' } })
    expect(r.status).toBe(200)
    const msg = tgCalls.find((c) => c.method === 'sendMessage')!
    expect(msg.body.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://kassa.test/')
    expect(msg.body.text).toContain('бесплатно')
  })

  it('/tg/ai-check is admin-only', async () => {
    expect((await call('/tg/ai-check', { body: {} })).status).toBe(403)
    const r = await call('/tg/ai-check', { body: {}, headers: { 'X-Setup-Key': 'test-webhook-secret' } })
    expect(r.json).toMatchObject({ geminiKey: false })
  })

  it('/tg/setup needs the secret and registers webhook with callback_query + menu button', async () => {
    expect((await call('/tg/setup', { body: {} })).status).toBe(403)
    expect((await call('/tg/setup', { body: {}, headers: { 'X-Setup-Key': 'wrong' } })).status).toBe(403)
    const r = await call('/tg/setup', { body: {}, headers: { 'X-Setup-Key': 'test-webhook-secret' } })
    expect(r.status).toBe(200)
    const hook = tgCalls.find((c) => c.method === 'setWebhook')!
    expect(hook.body).toMatchObject({ url: 'https://kassa.test/tg/webhook', secret_token: 'test-webhook-secret', allowed_updates: ['message', 'callback_query'] })
    expect(tgCalls.find((c) => c.method === 'setChatMenuButton')!.body.menu_button.web_app.url).toBe('https://kassa.test/')
    expect(JSON.stringify(r.json)).not.toContain('test-webhook-secret')
  })

  it('/extend from the admin chat extends the subscription; expired shops cannot write', async () => {
    const a = await onboard('Muddatli')
    // Sinovni o'tmishga suramiz (D1 + DO nusxasi).
    await env.DB.prepare("UPDATE tenants SET trial_until = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(a.shopId).run()
    await env.SHOP.get(env.SHOP.idFromName(a.shopId)).setSubscription({ trialUntil: '2020-01-01T00:00:00.000Z', paidUntil: null, status: 'active' })
    expect((await rpc(a.token, 'saveCategory', ['X'])).json).toMatchObject({ error: { code: 'cloud.errors.subscriptionExpired', status: 402 } })
    expect((await rpc(a.token, 'listCategories', [])).status).toBe(200)

    const upd = (text: string, chat = 777) => ({ message: { chat: { id: chat, type: 'private' }, from: { id: chat }, text } })
    const hdr = { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }
    // Begona chatdan admin buyrug'i ishlamaydi.
    await call('/tg/webhook', { body: upd(`/extend ${a.shopId.slice(0, 10)} 2099-12-01`, 555), headers: hdr })
    expect((await rpc(a.token, 'saveCategory', ['X'])).status).toBe(402)

    await call('/tg/webhook', { body: upd(`/extend ${a.shopId.slice(0, 10)} 2099-12-01`), headers: hdr })
    const t = await env.DB.prepare('SELECT paid_until FROM tenants WHERE id = ?').bind(a.shopId).first<{ paid_until: string }>()
    expect(t?.paid_until).toBe('2099-12-01T18:59:59.999Z')
    expect((await rpc(a.token, 'saveCategory', ['X'])).status).toBe(200)

    await call('/tg/webhook', { body: upd('/tenants'), headers: hdr })
    expect(tgCalls.at(-1)?.body.text).toContain('Muddatli')
  })
})

describe('admin panel in the app', () => {
  it('only the ADMIN_CHAT_ID user sees it; extend and block reach the shop at once', async () => {
    const admin = await onboard('Admin dokoni', { id: 777, first_name: 'Admin', username: 'boss', language_code: 'uz' })
    expect(admin.json.admin).toBe(true)
    const a = await onboard('Muddati tugagan')
    expect(a.json.admin).toBe(false)
    // Oddiy ega admin API'ga kira olmaydi (sessiyasiz ham).
    expect((await call('/api/admin/tenants', { token: a.token })).status).toBe(403)
    expect((await call('/api/admin/tenants')).status).toBe(401)
    expect((await call('/api/admin/extend', { token: a.token, body: { id: a.shopId, until: '2099-01-01' } })).status).toBe(403)

    await env.DB.prepare("UPDATE tenants SET trial_until = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(a.shopId).run()
    await env.SHOP.get(env.SHOP.idFromName(a.shopId)).setSubscription({ trialUntil: '2020-01-01T00:00:00.000Z', paidUntil: null, status: 'active' })
    const list = await call('/api/admin/tenants', { token: admin.token })
    const row = (list.json.data as any[]).find((t) => t.id === a.shopId)
    expect(row).toMatchObject({ name: 'Muddati tugagan', state: 'expired', members: 1, own: false })
    expect((list.json.data as any[]).find((t) => t.id === admin.shopId)).toMatchObject({ state: 'trial', own: true, owner_username: 'boss' })
    expect((await rpc(a.token, 'saveCategory', ['X'])).status).toBe(402)

    // Uzaytirish — Toshkent kuni oxirigacha; do'kon darhol yoza oladi.
    const ext = await call('/api/admin/extend', { token: admin.token, body: { id: a.shopId, until: '2099-03-01' } })
    expect(ext.json.data).toMatchObject({ state: 'paid', paid_until: '2099-03-01T18:59:59.999Z', until: '2099-03-01T18:59:59.999Z' })
    expect((await rpc(a.token, 'saveCategory', ['X'])).status).toBe(200)
    // Noto'g'ri kirish.
    expect((await call('/api/admin/extend', { token: admin.token, body: { id: a.shopId, until: '01.03.2099' } })).status).toBe(400)
    expect((await call('/api/admin/extend', { token: admin.token, body: { id: 'f'.repeat(32), until: '2099-03-01' } })).status).toBe(404)
    expect((await call('/api/admin/status', { token: admin.token, body: { id: a.shopId, status: 'deleted' } })).status).toBe(400)

    // Bloklash — yozish to'xtaydi, o'qish ochiq; blokdan chiqarish — qaytadi.
    expect((await call('/api/admin/status', { token: admin.token, body: { id: a.shopId, status: 'blocked' } })).json.data).toMatchObject({ state: 'blocked' })
    expect((await rpc(a.token, 'saveCategory', ['Y'])).status).toBe(402)
    expect((await rpc(a.token, 'listCategories', [])).status).toBe(200)
    expect((await call('/api/admin/status', { token: admin.token, body: { id: a.shopId, status: 'active' } })).json.data).toMatchObject({ state: 'paid' })
    expect((await rpc(a.token, 'saveCategory', ['Y'])).status).toBe(200)
    // AI: admin do'kon uchun o'chiradi — darhol, sessiyada ko'rinadi; boshqalar o'zgartira olmaydi.
    expect((await call('/api/session/refresh', { token: a.token })).json).toMatchObject({ ai: true })
    expect((await call('/api/admin/ai', { token: admin.token, body: { id: a.shopId, enabled: false } })).json.data).toMatchObject({ ai: false })
    expect((await call('/api/session/refresh', { token: a.token })).json).toMatchObject({ ai: false })
    expect((await call('/api/admin/ai', { token: a.token, body: { id: a.shopId, enabled: true } })).status).toBe(403)
    expect((await call('/api/admin/ai', { token: admin.token, body: { id: a.shopId, enabled: 'yes' } })).status).toBe(400)
    expect((await call('/api/admin/ai', { token: admin.token, body: { id: a.shopId, enabled: true } })).json.data).toMatchObject({ ai: true })
    expect((await call('/api/session/refresh', { token: a.token })).json).toMatchObject({ ai: true })
    // Admin o'z do'konini bloklay olmaydi.
    expect((await call('/api/admin/status', { token: admin.token, body: { id: admin.shopId, status: 'blocked' } })).json).toMatchObject({ error: { code: 'cloud.admin.errors.ownShop' } })
  })

  it('admin opens any shop read-only: sees its data, cannot write, leaves no trace in the shop', async () => {
    const admin = await onboard('Admin dokoni', { id: 777, first_name: 'Admin', username: 'boss', language_code: 'uz' })
    const a = await onboard('Mijoz dokoni', tgUser('Mijoz', 'mijoz_ega'))
    await rpc(a.token, 'saveProduct', [{ name: 'Choy', price: 5000 }])
    // Muddati tugagan do'kon ham ko'rinadi.
    await env.DB.prepare("UPDATE tenants SET trial_until = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(a.shopId).run()
    await env.SHOP.get(env.SHOP.idFromName(a.shopId)).setSubscription({ trialUntil: '2020-01-01T00:00:00.000Z', paidUntil: null, status: 'active' })

    // Oddiy ega boshqa do'konga kira olmaydi; noto'g'ri / yo'q id.
    expect((await call('/api/admin/view', { token: a.token, body: { id: admin.shopId } })).status).toBe(403)
    expect((await call('/api/admin/view', { token: admin.token, body: { id: 'nope' } })).status).toBe(400)
    expect((await call('/api/admin/view', { token: admin.token, body: { id: 'f'.repeat(32) } })).status).toBe(404)

    const v = await call('/api/admin/view', { token: admin.token, body: { id: a.shopId } })
    expect(v.status).toBe(200)
    expect(v.json).toMatchObject({
      status: 'ok', user: { uid: 777, role: 'owner' }, shop: { id: a.shopId, name: 'Mijoz dokoni' },
      shops: [], admin: true, ai: false, view: { owner: '@mijoz_ega' }, shift: null, member: null,
    })
    const vt = v.json.token as string
    expect((await verifySession(vt, env.SESSION_KEY, Math.floor(Date.now() / 1000)))?.v).toBe(1)

    // O'qish ishlaydi (egasidek — hisobot ham).
    expect((await rpc(vt, 'listProducts', [])).json.data.map((p: { name: string }) => p.name)).toEqual(['Choy'])
    expect((await rpc(vt, 'reportSummary', ['2026-01-01', '2026-12-31'])).status).toBe(200)
    // Har qanday yozuv — rad, kalit bilan ham; do'konda hech narsa paydo bo'lmaydi.
    for (const [op, args] of [['saveCategory', ['X']], ['openShift', [0]], ['setSetting', ['shop_name', 'Buzildi']], ['deleteProduct', [1]]] as const) {
      const r = await rpc(vt, op, [...args], `view-${op}-key`)
      expect(r.status).toBe(403)
      expect(r.json.error.code).toBe('cloud.admin.viewOnly')
    }
    expect((await rpc(a.token, 'listCategories', [])).json.data).toEqual([])
    expect((await rpc(a.token, 'listProducts', [])).json.data).toHaveLength(1)
    // Admin do'kon a'zosi bo'lmadi (D1 ham, DO nusxasi ham).
    const d1 = await env.DB.prepare('SELECT uid FROM members WHERE tenant_id = ?').bind(a.shopId).all<{ uid: number }>()
    expect(d1.results.map((m) => m.uid)).toEqual([a.user.id])
    const doMembers = await runInDurableObject(env.SHOP.get(env.SHOP.idFromName(a.shopId)), (_i, state) => state.storage.sql.exec('SELECT uid FROM members').toArray())
    expect(doMembers.map((m) => m.uid)).toEqual([a.user.id])

    // RPC'dan boshqa endpoint'lar ko'rish tokeni bilan — rad.
    for (const p of ['/api/staff/list', '/api/staff/invite', '/api/transfers/list', '/api/group/report', '/api/receipt', '/api/session/switch', '/api/shops/create', '/api/admin/tenants', '/api/admin/view', '/api/admin/extend', '/api/assistant/chats']) {
      expect((await call(p, { token: vt, body: { id: a.shopId } })).json?.error?.code, p).toBe('cloud.admin.viewOnly')
    }
    // Yangilash — yana ko'rish tokeni, o'sha do'kon.
    const re = await call('/api/session/refresh', { token: vt })
    expect(re.json).toMatchObject({ shop: { id: a.shopId }, view: { owner: '@mijoz_ega' }, shops: [] })
    expect((await verifySession(re.json.token, env.SESSION_KEY, Math.floor(Date.now() / 1000)))?.v).toBe(1)

    // Admin huquqi olinsa — ko'rish tokeni ishlamaydi (401: ilova initData bilan o'z do'koniga qaytadi).
    const noAdmin = { ...env, ADMIN_CHAT_ID: '' } as typeof env
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    const req = (path: string, body: unknown) => new Request(`https://kassa.test${path}`, { method: 'POST', headers: { Authorization: `Bearer ${vt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await route(req('/api/rpc/listProducts', { args: [] }), noAdmin, ctx)).status).toBe(401)
    expect((await route(req('/api/session/refresh', {}), noAdmin, ctx)).status).toBe(401)

    // Chiqish: faqat ko'rish tokeni bilan; qaytadi — adminning o'z do'koni, oddiy token, ko'rish belgisi yo'q.
    expect((await call('/api/admin/exit', { token: admin.token })).status).toBe(400)
    const out = await call('/api/admin/exit', { token: vt })
    expect(out.json).toMatchObject({ status: 'ok', shop: { id: admin.shopId } })
    expect(out.json.view).toBeUndefined()
    expect((await verifySession(out.json.token, env.SESSION_KEY, Math.floor(Date.now() / 1000)))?.v).toBeUndefined()
    expect((await rpc(out.json.token, 'saveCategory', ['Meniki'])).status).toBe(200)
    // Botdagi / keyingi kirishdagi tanlov o'zgarmagan.
    expect((await call('/api/session', { body: { initData: await initData({ id: 777 }) } })).json.shop.id).toBe(admin.shopId)
  })

  it('a session token cannot be turned into a view token without the key', async () => {
    const now = Math.floor(Date.now() / 1000)
    const good = await signSession({ t: 'a'.repeat(32), u: 5, r: 'owner', n: 'X' }, env.SESSION_KEY, now)
    const [, body, sig] = good.split('.')
    const p = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
    const forged = btoa(JSON.stringify({ ...p, v: 1 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(await verifySession(`v1.${forged}.${sig}`, env.SESSION_KEY, now)).toBeNull()
    expect(await verifySession(await signSession({ t: 'a'.repeat(32), u: 5, r: 'owner', n: 'X', v: 1 }, env.SESSION_KEY, now), env.SESSION_KEY, now)).toMatchObject({ v: 1 })
  })

  it('/admin in the admin chat answers with a button that opens the panel; menu lists admin commands', async () => {
    const hdr = { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }
    await call('/tg/webhook', { body: { message: { chat: { id: 777, type: 'private' }, from: { id: 777 }, text: '/admin' } }, headers: hdr })
    expect(tgCalls.at(-1)?.body.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://kassa.test/admin')
    await call('/tg/setup', { body: {}, headers: { 'X-Setup-Key': 'test-webhook-secret' } })
    const scoped = tgCalls.find((c) => c.method === 'setMyCommands' && c.body.scope)
    expect(scoped?.body.scope).toEqual({ type: 'chat', chat_id: 777 })
    expect(scoped?.body.commands.map((c: { command: string }) => c.command)).toEqual(['start', 'dokon', 'admin', 'tenants', 'extend', 'block', 'unblock'])
    // Hammaga ko'rinadigan menyuda /start va /dokon — admin buyruqlari oshkor bo'lmaydi.
    for (const c of tgCalls.filter((x) => x.method === 'setMyCommands' && !x.body.scope)) {
      expect(c.body.commands.map((x: { command: string }) => x.command)).toEqual(['start', 'dokon'])
    }
  })

  it('a non-admin typing /admin gets the generic help — no hint that the command exists', async () => {
    const hdr = { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }
    for (const cmd of ['/admin', '/tenants', '/extend abc 2099-01-01']) {
      await call('/tg/webhook', { body: { message: { chat: { id: 555, type: 'private' }, from: { id: 555 }, text: cmd } }, headers: hdr })
      const last = tgCalls.at(-1)!
      expect(last.body.text).toBe('Kassani ochish uchun tugmani bosing.')
      expect(JSON.stringify(last.body)).not.toMatch(/admin|tenants/i)
    }
  })
})

describe('receipt sharing', () => {
  it('prepares a formatted message for the user to share — never sends it to their own chat; HTML is escaped', async () => {
    const a = await onboard()
    const card = {
      shop: 'Zafar <aksessuar>', title: 'Chek #1-00002', meta: '09.11.2026 00:51 · Bahrom aka',
      items: [{ name: 'iPhone 18 Pro Max <script>', line: "1 dona × 19 179 456 so'm", sum: "19 179 456 so'm" }],
      total: { label: 'Jami', value: "19 179 456 so'm" },
      rows: [{ kind: 'debt', label: 'Qarz', value: "19 179 456 so'm" }, { kind: 'evil', label: 'x', value: 'y' }],
      foot: 'Xaridingiz uchun rahmat!',
    }
    const r = await call('/api/receipt', { token: a.token, body: { card } })
    expect(r.json).toEqual({ ok: true, data: { id: 'prep-1' } })
    expect(tgCalls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === a.user.id)).toHaveLength(0)
    const prep = tgCalls.find((c) => c.method === 'savePreparedInlineMessage')!
    expect(prep.body).toMatchObject({ user_id: a.user.id, allow_user_chats: true, allow_group_chats: true, result: { type: 'article', title: 'Chek #1-00002' } })
    const html = prep.body.result.input_message_content.message_text as string
    expect(prep.body.result.input_message_content.parse_mode).toBe('HTML')
    expect(html).toContain('🧾 <b>Zafar &lt;aksessuar&gt;</b>')
    expect(html).toContain('<blockquote>▪️ <b>iPhone 18 Pro Max &lt;script&gt;</b>')
    expect(html).toContain("✅ <b>Jami: 19 179 456 so'm</b>")
    expect(html).toContain("🔴 <b>Qarz: 19 179 456 so'm</b>")
    expect(html).not.toContain('evil')
    // Rasm + matn: chek rasmi saqlanadi, tayyor xabar — photo (izohda matn, saldolar bilan).
    const jpeg = new Uint8Array(2000); jpeg.set([0xff, 0xd8, 0xff, 0xe0]); jpeg[1999] = 7
    const img = btoa(String.fromCharCode(...jpeg))
    const withBal = { ...card, rows: [...card.rows.slice(0, 1), { kind: 'balance', label: 'Oldingi saldo', value: "3 000 000 so'm · Qarzdor" }, { kind: 'balance', label: 'Yangi saldo', value: "22 179 456 so'm · Qarzdor" }] }
    expect((await call('/api/receipt', { token: a.token, body: { card: withBal, image: img } })).json.ok).toBe(true)
    const photo = tgCalls.filter((c) => c.method === 'savePreparedInlineMessage').pop()!.body.result
    expect(photo).toMatchObject({ type: 'photo', parse_mode: 'HTML' })
    expect(photo.photo_url).toMatch(new RegExp(`^https://kassa\\.test/rimg/${a.shopId}/[a-f0-9]{32}\\.jpg$`))
    expect(photo.caption).toContain("📒 Yangi saldo: 22 179 456 so'm · Qarzdor")
    expect(photo.caption.length).toBeLessThanOrEqual(1024)
    const served = await call(new URL(photo.photo_url).pathname, { method: 'GET' })
    expect(served.res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(served.bytes.byteLength).toBe(2000)
    // JPEG bo'lmagan "rasm" rad etiladi; begona do'kon id bilan rasm topilmaydi.
    expect((await call('/api/receipt', { token: a.token, body: { card, image: btoa('x'.repeat(2000)) } })).status).toBe(400)
    expect((await call(new URL(photo.photo_url).pathname.replace(a.shopId, 'f'.repeat(32)), { method: 'GET' })).status).toBe(404)
    // Noto'g'ri karta va sessiyasiz so'rov rad etiladi.
    expect((await call('/api/receipt', { token: a.token, body: { card: { shop: 'x' } } })).status).toBe(400)
    expect((await call('/api/receipt', { body: { card } })).status).toBe(401)
  })
})

describe('maintenance alarm', () => {
  it('prunes idempotency keys older than 7 days', async () => {
    const a = await onboard()
    await rpc(a.token, 'saveCategory', ['Eski'], 'old-key-000001')
    await rpc(a.token, 'saveCategory', ['Yangi'], 'new-key-000001')
    const stub = env.SHOP.get(env.SHOP.idFromName(a.shopId))
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE idempotency SET created_at = '2020-01-01T00:00:00.000Z' WHERE key = 'old-key-000001'")
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    await runInDurableObject(stub, (_i, state) => {
      const keys = state.storage.sql.exec<{ key: string }>('SELECT key FROM idempotency').toArray().map((r) => r.key)
      expect(keys).toEqual(['new-key-000001'])
    })
  })
})
