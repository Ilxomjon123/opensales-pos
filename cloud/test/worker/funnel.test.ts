import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, initData, mockTelegram, onboard, rpc, shopDO, tg, tgUser } from './helpers'
import { inSendWindow, runFunnelCron } from '../../src/funnel'

// Varonka (2026-11-10): kirish → do'kon → tovar → sotuv → qaytib sotdi; avtomatik eslatmalar (bir martalik).
mockTelegram()

const hdr = { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }
const start = (u: { id: number; first_name: string }, payload = '') =>
  call('/tg/webhook', { body: { message: { chat: { id: u.id, type: 'private' }, from: { ...u, language_code: 'uz' }, text: `/start${payload ? ' ' + payload : ''}` } }, headers: hdr })
const row = (uid: number) => env.DB.prepare('SELECT * FROM funnel_users WHERE uid = ?').bind(uid).first<any>()
const nudge = (uid: number, kind: string) => env.DB.prepare('SELECT status FROM nudges WHERE uid = ? AND kind = ?').bind(uid, kind).first<{ status: string }>()
const sentTo = (uid: number) => tg.calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === uid)

/** Toshkent 12:00 (eslatma oynasi ichida), bugun. */
function noon(): Date { const d = new Date(); d.setUTCHours(7, 0, 0, 0); return d }
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms).toISOString()
const H = 3_600_000
/** Bot unga yoza oladigan odam (initData'da `allows_write_to_pm`, Telegram botda chat bo'lsa shunday beradi). */
const pmUser = (name: string) => Object.assign(tgUser(name), { allows_write_to_pm: true })

/** saveProduct qoldiqni o'zgartirmaydi (kirim orqali) — sotuv uchun qoldiq to'g'ridan qo'yiladi. */
async function newProduct(token: string, shopId: string, name: string, price: number): Promise<number> {
  await rpc(token, 'saveProduct', [{ name, price }])
  const id = ((await rpc(token, 'listProducts', [])).json.data as { id: number; name: string }[]).find((p) => p.name === name)!.id
  await runInDurableObject(shopDO(shopId), (_i, state) => { state.storage.sql.exec('UPDATE products SET stock = 100 WHERE id = ?', id) })
  return id
}

async function admin() {
  return onboard('Admin dokoni', { id: 777, first_name: 'Admin', language_code: 'uz' })
}
async function enableNudges(token: string) {
  const r = await call('/api/admin/nudges', { token, body: { enabled: true } })
  expect(r.json.data.nudges.enabled).toBe(true)
}

describe('funnel tracking', () => {
  it('records bot start with its source, app open and the first shop; first source wins', async () => {
    const u = tgUser('Lid')
    await start(u, 'ig_reel')
    expect(await row(u.id)).toMatchObject({ src: 'ig_reel', name: 'Lid', shop_id: null })
    expect((await row(u.id)).started_at).toBeTruthy()

    const s = await call('/api/session', { body: { initData: await initData(u, { start_param: 'tg_post' }) } })
    expect(s.json.status).toBe('new')
    expect(await row(u.id)).toMatchObject({ src: 'ig_reel' })
    expect((await row(u.id)).opened_at).toBeTruthy()

    const shop = await onboard('Lid dokoni', u)
    expect(await row(u.id)).toMatchObject({ shop_id: shop.shopId })
    // Bosqich vaqti birinchi marta yoziladi va o'zgarmaydi.
    const first = (await row(u.id)).started_at
    await start(u, 'other')
    expect(await row(u.id)).toMatchObject({ started_at: first, src: 'ig_reel' })
    // Noto'g'ri manba yozilmaydi.
    const v = tgUser('Boshqa')
    await start(v, '<script>')
    expect((await row(v.id)).src).toBeNull()
  })

  it('does not count invited cashiers', async () => {
    const o = await onboard('Kassirli')
    const link = (await call('/api/staff/invite', { token: o.token })).json.data.link as string
    const k = tgUser('Kassir')
    await start(k, link.split('start=')[1])
    await call('/api/session', { body: { initData: await initData(k), invite: link.split('inv_')[1] } })
    expect(await row(k.id)).toBeNull()
    // Keyin taklifsiz ochsa ham (kassir) — varonkaga kirmaydi.
    await call('/api/session', { body: { initData: await initData(k) } })
    expect(await row(k.id)).toBeNull()
  })

  it('reports shop progress in the session and as a read op; day2 = a sale on a later Tashkent day', async () => {
    const o = await onboard('Progress')
    expect(o.json.progress).toEqual({ products: 0, sales: 0, shifts: 0, firstSaleAt: null, lastSaleAt: null, day2At: null })
    const pid = await newProduct(o.token, o.shopId, 'Non', 4000)
    const shift = (await rpc(o.token, 'openShift', [0])).json.data
    const walkIn = (await rpc(o.token, 'listCustomers', [])).json.data[0]
    expect((await rpc(o.token, 'createSale', [{ shiftId: shift.id, customerId: walkIn.id, items: [{ product_id: pid, qty: 1, price: 4000 }], paidCash: 4000, paidCard: 0, discount: 0 }])).status).toBe(200)
    let p = (await rpc(o.token, 'shopProgress', [])).json.data
    expect(p).toMatchObject({ products: 1, sales: 1, shifts: 1, day2At: null })
    // Birinchi sotuvni kechaga (Toshkent) suramiz — bugungisi "qaytib sotdi" bo'ladi.
    await runInDurableObject(shopDO(o.shopId), (_i, state) => {
      state.storage.sql.exec("UPDATE sales SET created_at = ? WHERE id = (SELECT MIN(id) FROM sales)", new Date(Date.now() - 30 * H).toISOString())
    })
    expect((await rpc(o.token, 'createSale', [{ shiftId: shift.id, customerId: walkIn.id, items: [{ product_id: pid, qty: 1, price: 4000 }], paidCash: 4000, paidCard: 0, discount: 0 }])).status).toBe(200)
    p = (await rpc(o.token, 'shopProgress', [])).json.data
    expect(p.sales).toBe(2)
    expect(p.day2At).toBe(p.lastSaleAt)
  })
})

describe('first sale is not blocked', () => {
  it('new cloud shops sell a product added without stock (the POS no longer hides it)', async () => {
    const o = await onboard('Qoldiqsiz')
    expect(o.json.settings.allow_negative_stock).toBe('1')
    await rpc(o.token, 'saveProduct', [{ name: 'Non', price: 4000 }])
    const pid = (await rpc(o.token, 'listProducts', [])).json.data[0].id
    const shift = (await rpc(o.token, 'openShift', [0])).json.data
    const walkIn = (await rpc(o.token, 'listCustomers', [])).json.data[0]
    expect((await rpc(o.token, 'createSale', [{ shiftId: shift.id, customerId: walkIn.id, items: [{ product_id: pid, qty: 1, price: 4000 }], paidCash: 4000, paidCard: 0, discount: 0 }])).status).toBe(200)
    // Ega o'chirsa — odatdagidek rad.
    await rpc(o.token, 'setSetting', ['allow_negative_stock', '0'])
    expect((await rpc(o.token, 'createSale', [{ shiftId: shift.id, customerId: walkIn.id, items: [{ product_id: pid, qty: 1, price: 4000 }], paidCash: 4000, paidCard: 0, discount: 0 }])).status).toBe(409)
  })

  it('DO migration V6 turns it on only for shops with no sales and no explicit choice', async () => {
    const { migrate } = await import('../../src/shop/schema')
    const { doSql } = await import('../../src/shop/sql')
    for (const [name, sold, explicit, want] of [['Bo\'sh', false, null, '1'], ['Sotgan', true, null, null], ['Tanlagan', false, '0', '0']] as const) {
      const o = await onboard(name)
      const got = await runInDurableObject(shopDO(o.shopId), (_i, state) => {
        const x = state.storage.sql
        x.exec("DELETE FROM settings WHERE key = 'allow_negative_stock'")
        if (explicit) x.exec("INSERT INTO settings(key, value) VALUES('allow_negative_stock', ?)", explicit)
        if (sold) x.exec("INSERT INTO sales(receipt_number, total, created_at) VALUES('1-00001', 1, '2026-11-01T00:00:00.000Z')")
        x.exec("UPDATE meta SET value = '5' WHERE key = 'schema_version'")
        migrate(doSql(state.storage))
        return (x.exec("SELECT value FROM settings WHERE key = 'allow_negative_stock'").toArray()[0] as { value?: string } | undefined)?.value ?? null
      })
      expect(got, name).toBe(want)
    }
  })
})

describe('funnel cron and nudges', () => {
  it('refreshes progress but sends nothing while nudges are off', async () => {
    const now = noon()
    const o = await onboard('Jim')
    await env.DB.prepare('UPDATE funnel_users SET shop_at = ? WHERE uid = ?').bind(ago(now, 4 * H), o.user.id).run()
    await runFunnelCron(env, now, 7)
    expect(await row(o.user.id)).toMatchObject({ products: 0, sales: 0 })
    expect((await row(o.user.id)).checked_at).toBe(now.toISOString())
    expect(sentTo(o.user.id)).toHaveLength(0)
  })

  it('walks a new owner through no_product → no_sale once each, then stops after the first sale', async () => {
    const now = noon()
    const a = await admin()
    await enableNudges(a.token)
    const o = await onboard("Yangi do'kon", pmUser('Yangi'))
    await env.DB.prepare('UPDATE funnel_users SET shop_at = ? WHERE uid = ?').bind(ago(now, 4 * H), o.user.id).run()

    await runFunnelCron(env, now, 7)
    expect(sentTo(o.user.id)).toHaveLength(1)
    expect(sentTo(o.user.id)[0].body.text).toContain("Yangi do'kon")
    expect(sentTo(o.user.id)[0].body.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://kassa.test/products?new=1')
    expect(await nudge(o.user.id, 'no_product')).toEqual({ status: 'sent' })
    // Takror cron — ikkinchi marta yozilmaydi.
    await runFunnelCron(env, now, 7)
    expect(sentTo(o.user.id)).toHaveLength(1)

    // Tovar qo'shdi, sutka o'tdi, sotuv yo'q → bitta "birinchi sotuv" eslatmasi.
    const pid = await newProduct(o.token, o.shopId, 'Choy', 5000)
    await env.DB.prepare('UPDATE funnel_users SET shop_at = ? WHERE uid = ?').bind(ago(now, 25 * H), o.user.id).run()
    await runFunnelCron(env, now, 7)
    expect(sentTo(o.user.id)).toHaveLength(2)
    expect(sentTo(o.user.id)[1].body.text).toContain('1 ta')
    expect((await row(o.user.id)).product_at).toBeTruthy()

    // Sotdi → bosqich yoziladi, boshqa eslatma yo'q.
    const shift = (await rpc(o.token, 'openShift', [0])).json.data
    const walkIn = (await rpc(o.token, 'listCustomers', [])).json.data[0]
    expect((await rpc(o.token, 'createSale', [{ shiftId: shift.id, customerId: walkIn.id, items: [{ product_id: pid, qty: 1, price: 5000 }], paidCash: 5000, paidCard: 0, discount: 0 }])).status).toBe(200)
    await runFunnelCron(env, now, 7)
    expect(sentTo(o.user.id)).toHaveLength(2)
    expect((await row(o.user.id)).sale_at).toBeTruthy()
  })

  it('nudges someone who started but opened no shop; never a cashier, never at night, never twice', async () => {
    const now = noon()
    const a = await admin()
    await enableNudges(a.token)
    const lid = tgUser('Lid')
    await start(lid, 'ig_reel')
    await env.DB.prepare('UPDATE funnel_users SET started_at = ? WHERE uid = ?').bind(ago(now, 40 * 60_000), lid.id).run()
    // Kassir: varonka qatori bo'lsa ham (/start dan), a'zoligi bor — yozilmaydi.
    const o = await onboard('Kassirli 2')
    const link = (await call('/api/staff/invite', { token: o.token })).json.data.link as string
    const k = tgUser('Kassir')
    await start(k)
    await call('/api/session', { body: { initData: await initData(k), invite: link.split('inv_')[1] } })
    await env.DB.prepare('UPDATE funnel_users SET started_at = ? WHERE uid = ?').bind(ago(now, 40 * 60_000), k.id).run()

    tg.calls = [] // /start salomlari hisobga kirmasin
    const night = new Date(now.getTime() + 13 * H) // Toshkent 01:00
    expect(inSendWindow(night)).toBe(false)
    await runFunnelCron(env, night, 7)
    expect(sentTo(lid.id)).toHaveLength(0)

    await runFunnelCron(env, now, 7)
    expect(sentTo(lid.id)).toHaveLength(1)
    expect(sentTo(lid.id)[0].body.text).toContain('7 kun bepul')
    expect(sentTo(k.id)).toHaveLength(0)
    await runFunnelCron(env, now, 7)
    expect(sentTo(lid.id)).toHaveLength(1)
  })

  it('a failed send is recorded and not retried; trial_end needs a support username', async () => {
    const now = noon()
    const a = await admin()
    await enableNudges(a.token)
    const o = await onboard('Sinov tugaydi', pmUser('Sinov'))
    await rpc(o.token, 'saveProduct', [{ name: 'Olma', price: 1000 }])
    // Sinov 1 kunda tugaydi; tovar/sotuv eslatmalari allaqachon yuborilgan deb belgilaymiz.
    await env.DB.prepare('UPDATE tenants SET trial_until = ? WHERE id = ?').bind(new Date(now.getTime() + 24 * H).toISOString(), o.shopId).run()
    for (const k of ['no_product', 'no_sale']) await env.DB.prepare("INSERT INTO nudges (uid, kind, status, at) VALUES (?, ?, 'sent', ?)").bind(o.user.id, k, now.toISOString()).run()
    await runFunnelCron({ ...env, SUPPORT_USERNAME: '' } as typeof env, now, 7)
    expect(sentTo(o.user.id)).toHaveLength(0)

    const withSupport = { ...env, SUPPORT_USERNAME: 'opensales_help' } as typeof env
    await runFunnelCron(withSupport, now, 7)
    expect(sentTo(o.user.id)).toHaveLength(1)
    expect(sentTo(o.user.id)[0].body.text).toContain('@opensales_help')

    // Telegram rad etsa (bot bloklangan) — 'failed', qayta urinilmaydi.
    const u = tgUser('Bloklagan')
    await start(u)
    await env.DB.prepare('UPDATE funnel_users SET started_at = ? WHERE uid = ?').bind(ago(now, 40 * 60_000), u.id).run()
    tg.calls = []
    ;(globalThis.fetch as any).mockImplementationOnce(async () => Response.json({ ok: false, description: 'Forbidden: bot was blocked by the user' }, { status: 403 }))
    await runFunnelCron(env, now, 7)
    expect(await nudge(u.id, 'no_shop')).toEqual({ status: 'failed' })
    // Telegram aniq "yozib bo'lmaydi" dedi — boshqa eslatma turlari ham unga yuborilmaydi (ruxsat bermaguncha).
    expect((await row(u.id)).pm_at).toBeNull()
    await runFunnelCron(env, now, 7)
    expect(sentTo(u.id)).toHaveLength(0)
  })
})

describe('bot write access (people who opened the app straight from an ad)', () => {
  const allow = async (u: { id: number }, body: Record<string, unknown> = { allowed: true }) =>
    call('/api/write-access', { body: { initData: await initData(u), ...body } })

  it('the session says the bot cannot write yet; nudges skip them until they allow it in the app', async () => {
    const now = noon()
    const a = await admin()
    await enableNudges(a.token)
    const u = tgUser('Reklama')
    expect((await call('/api/session', { body: { initData: await initData(u, { start_param: 'ig_reel' }) } })).json.status).toBe('new')
    expect((await row(u.id)).pm_at).toBeNull()
    const o = await onboard('Reklamadan', u)
    expect(o.json.pm).toBe(false)
    await env.DB.prepare('UPDATE funnel_users SET shop_at = ? WHERE uid = ?').bind(ago(now, 4 * H), u.id).run()
    await runFunnelCron(env, now, 7)
    expect(sentTo(u.id)).toHaveLength(0)
    expect(await nudge(u.id, 'no_product')).toBeNull()

    expect((await allow(u, { allowed: false })).status).toBe(400)
    expect((await call('/api/write-access', { body: { initData: 'bad', allowed: true } })).status).toBe(401)
    expect((await allow(u)).status).toBe(200)
    expect((await row(u.id)).pm_at).toBeTruthy()
    expect((await call('/api/session', { body: { initData: await initData(u) } })).json.pm).toBe(true)
    expect((await call('/api/session/refresh', { token: o.token, body: {} })).json.pm).toBe(true)

    await runFunnelCron(env, now, 7)
    expect(sentTo(u.id)).toHaveLength(1)
    expect(await nudge(u.id, 'no_product')).toEqual({ status: 'sent' })
  })

  it('initData allows_write_to_pm and /start count as reachable; cashiers are never asked or tracked', async () => {
    const v = pmUser('Ruxsatli')
    const o = await onboard('Ruxsatli', v)
    expect(o.json.pm).toBe(true)
    expect((await row(v.id)).pm_at).toBeTruthy()

    const w = tgUser('Botdan')
    await start(w)
    expect((await call('/api/session', { body: { initData: await initData(w) } })).json.status).toBe('new')
    expect((await onboard('Botdan', w)).json.pm).toBe(true)

    const link = (await call('/api/staff/invite', { token: o.token })).json.data.link as string
    const k = tgUser('Kassir')
    const ks = await call('/api/session', { body: { initData: await initData(k), invite: link.split('inv_')[1] } })
    expect(ks.json.pm).toBeNull()
    // Kassir ruxsat bersa ham varonkaga qator qo'shilmaydi.
    expect((await allow(k)).status).toBe(200)
    expect(await row(k.id)).toBeNull()
  })

  it('outreach records who the bot reached; "chat not found" clears it until they start the bot', async () => {
    const send = (uid: number, key: string) => call('/tg/outreach', { body: { uid, key, text: 'Salom', buttons: [] }, headers: { 'X-Setup-Key': 'test-webhook-secret' } })
    const u = tgUser('Yetmadi')
    await call('/api/session', { body: { initData: await initData(u) } })
    ;(globalThis.fetch as any).mockImplementationOnce(async () => Response.json({ ok: false, description: 'Bad Request: chat not found' }, { status: 400 }))
    expect((await send(u.id, 'a')).json.data).toMatchObject({ status: 'failed' })
    expect((await row(u.id)).pm_at).toBeNull()
    await start(u)
    expect((await row(u.id)).pm_at).toBeTruthy()

    const v = tgUser('Yetdi')
    await call('/api/session', { body: { initData: await initData(v) } })
    expect((await send(v.id, 'b')).json.data).toEqual({ status: 'sent' })
    expect((await row(v.id)).pm_at).toBeTruthy()
  })

  it('Excel export to a chat that does not exist asks the app to get permission (409 botBlocked)', async () => {
    const o = await onboard('Eksport')
    ;(globalThis.fetch as any).mockImplementationOnce(async () => Response.json({ ok: false, description: 'Bad Request: chat not found' }, { status: 400 }))
    const r = await call('/api/export?name=a.csv', { token: o.token, body: 'x' })
    expect(r.status).toBe(409)
    expect(r.json.error.code).toBe('cloud.errors.botBlocked')
    ;(globalThis.fetch as any).mockImplementationOnce(async () => Response.json({ ok: false, description: 'Bad Request: file is too big' }, { status: 400 }))
    expect((await call('/api/export?name=a.csv', { token: o.token, body: 'x' })).json.error.code).toBe('cloud.errors.telegramFailed')
  })
})

describe('admin funnel report', () => {
  it('shows stages, sources and people to the admin only; toggles nudges', async () => {
    const a = await admin()
    const u = tgUser('Hisobot')
    await start(u, 'ig_story')
    const shop = await onboard('Hisobot dokoni', u)
    await rpc(shop.token, 'saveProduct', [{ name: 'Sut', price: 9000 }])

    expect((await call('/api/admin/funnel', { token: shop.token, body: {} })).status).toBe(403)
    const r = await call('/api/admin/funnel', { token: a.token, body: { days: 7 } })
    expect(r.status).toBe(200)
    const me = r.json.data.rows.find((x: any) => x.uid === u.id)
    expect(me).toMatchObject({ src: 'ig_story', shop_name: 'Hisobot dokoni', products: 1, sales: 0 })
    expect(me.product_at).toBeTruthy()
    expect(r.json.data.rows.some((x: any) => x.uid === 777)).toBe(false)
    expect(r.json.data.sources.find((x: any) => x.src === 'ig_story')).toMatchObject({ n: 1, shop: 1, sale: 0 })
    const st = r.json.data.stages
    expect(st.entered).toBeGreaterThanOrEqual(st.shop)
    expect(st.shop).toBeGreaterThanOrEqual(st.product)

    expect((await call('/api/admin/funnel', { token: a.token, body: { days: -1 } })).status).toBe(400)
    expect((await call('/api/admin/nudges', { token: a.token, body: { enabled: 'yes' } })).status).toBe(400)
    expect((await call('/api/admin/nudges', { token: a.token, body: { enabled: false } })).json.data.nudges.enabled).toBe(false)
  })
})

describe('founder outreach via the bot', () => {
  const send = (body: Record<string, unknown>, key = 'test-webhook-secret') => call('/tg/outreach', { body, headers: { 'X-Setup-Key': key } })
  const msg = (uid: number) => ({ uid, key: 'founder-1', text: 'Salom <b>X</b>', buttons: [{ text: 'Yozish', url: 'https://t.me/Abdullayev_Ilxomjon' }, { text: 'Kassa', app: '' }] })

  it('sends once to a known user with t.me and app buttons; refuses strangers, bad input and a wrong key', async () => {
    const o = await onboard('Outreach')
    expect((await send(msg(o.user.id), 'wrong')).status).toBe(403)
    expect((await send(msg(999_000_123))).status).toBe(404)
    expect((await send({ ...msg(o.user.id), buttons: [{ text: 'Fishing', url: 'https://evil.example/x' }] })).json.error.params.field).toBe('buttons')
    expect((await send({ ...msg(o.user.id), text: '' })).json.error.params.field).toBe('text')
    expect((await send({ ...msg(o.user.id), key: 'bad key!' })).json.error.params.field).toBe('key')

    const r = await send(msg(o.user.id))
    expect(r.json.data).toEqual({ status: 'sent' })
    const sent = sentTo(o.user.id)
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toMatchObject({ text: 'Salom <b>X</b>', parse_mode: 'HTML' })
    expect(sent[0].body.reply_markup.inline_keyboard).toEqual([[{ text: 'Yozish', url: 'https://t.me/Abdullayev_Ilxomjon' }], [{ text: 'Kassa', web_app: { url: 'https://kassa.test/' } }]])
    // Takror (tarmoq uzildi deb qayta bosildi) — ikkinchi xabar yo'q.
    expect((await send(msg(o.user.id))).json.data).toEqual({ status: 'already_sent' })
    expect(sentTo(o.user.id)).toHaveLength(1)
  })
})
