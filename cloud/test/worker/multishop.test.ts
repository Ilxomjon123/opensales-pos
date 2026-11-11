import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, initData, mockTelegram, onboard, rpc, shopDO, tg, tgUser } from './helpers'

// Bir egada bir nechta do'kon (2026-11-09): alohida do'kon, filial (umumiy katalog), guruh obunasi.
mockTelegram()

const createShop = (token: string, body: Record<string, unknown>) => call('/api/shops/create', { token, body })
const switchTo = (token: string, shopId: string) => call('/api/session/switch', { token, body: { shopId } })
const webp = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'

async function setStock(shopId: string, pid: number, stock: number) {
  await runInDurableObject(shopDO(shopId), (_i, state) => { state.storage.sql.exec('UPDATE products SET stock = ? WHERE id = ?', stock, pid) })
}

describe('several shops per owner', () => {
  it('creates a second shop, lists both, switches only to own shops', async () => {
    const a = await onboard("Chilonzor do'koni")
    const b = await createShop(a.token, { name: 'Yunusobod' })
    expect(b.status).toBe(200)
    expect(b.json).toMatchObject({ status: 'ok', user: { role: 'owner' }, shop: { name: 'Yunusobod', group: a.shopId, catalogOf: null } })
    expect(b.json.shops.map((x: any) => x.name)).toEqual(["Chilonzor do'koni", 'Yunusobod'])
    const bId = b.json.shop.id as string
    // Ma'lumot alohida.
    await rpc(a.token, 'saveProduct', [{ name: 'Faqat A', price: 1 }])
    expect((await rpc(b.json.token, 'listProducts', [])).json.data).toEqual([])

    const back = await switchTo(b.json.token, a.shopId)
    expect(back.json).toMatchObject({ shop: { id: a.shopId } })
    expect((await rpc(back.json.token, 'listProducts', [])).json.data).toHaveLength(1)
    // Keyingi kirish — oxirgi tanlangan do'kon.
    const again = await call('/api/session', { body: { initData: await initData(a.user) } })
    expect(again.json.shop.id).toBe(a.shopId)
    await switchTo(back.json.token, bId)
    expect((await call('/api/session', { body: { initData: await initData(a.user) } })).json.shop.id).toBe(bId)

    // Begona do'konga o'tib bo'lmaydi.
    const other = await onboard('Begona')
    expect((await switchTo(a.token, other.shopId)).status).toBe(403)
    expect((await switchTo(a.token, 'nope')).status).toBe(400)
  })

  it('shares the subscription of the first shop; admin /extend covers the whole business', async () => {
    const a = await onboard('Obunali')
    const b = await createShop(a.token, { name: 'Ikkinchi' })
    const bId = b.json.shop.id as string
    const rows = await env.DB.prepare('SELECT id, trial_until, paid_until FROM tenants WHERE group_id = ? ORDER BY created_at').bind(a.shopId).all<any>()
    expect(rows.results).toHaveLength(2)
    expect(rows.results[1].trial_until).toBe(rows.results[0].trial_until)

    // Muddat o'tdi (ikkalasida) → yozish 402; ildizni emas, IKKINCHISINI uzaytirish ham butun biznesni ochadi.
    await env.DB.prepare("UPDATE tenants SET trial_until = '2020-01-01T00:00:00.000Z' WHERE group_id = ?").bind(a.shopId).run()
    for (const id of [a.shopId, bId]) await shopDO(id).setSubscription({ trialUntil: '2020-01-01T00:00:00.000Z', paidUntil: null, status: 'active' })
    expect((await rpc(a.token, 'saveCategory', ['X'])).status).toBe(402)
    expect((await rpc(b.json.token, 'saveCategory', ['X'])).status).toBe(402)
    const hdr = { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }
    await call('/tg/webhook', { body: { message: { chat: { id: 777, type: 'private' }, from: { id: 777 }, text: `/extend ${bId.slice(0, 12)} 2099-12-01` } }, headers: hdr })
    expect((await rpc(a.token, 'saveCategory', ['X'])).status).toBe(200)
    expect((await rpc(b.json.token, 'saveCategory', ['X'])).status).toBe(200)
    expect(tg.calls.at(-1)?.body.text).toContain("2 do'kon")
  })

  it('limits shops per business, rejects duplicate names, treats a double tap as one', async () => {
    const a = await onboard('Limit')
    const first = await createShop(a.token, { name: 'Filial 1' })
    const dup = await createShop(a.token, { name: 'filial 1' })
    expect(dup.json.shop.id).toBe(first.json.shop.id) // bir daqiqa ichida o'sha odam — o'sha do'kon
    await env.DB.prepare("UPDATE tenants SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(first.json.shop.id).run()
    expect((await createShop(a.token, { name: 'FILIAL 1' })).json).toMatchObject({ error: { code: 'cloud.shops.errors.nameTaken' } })
    for (let i = 2; i <= 9; i++) expect((await createShop(a.token, { name: `Filial ${i}` })).status).toBe(200)
    expect((await createShop(a.token, { name: 'Filial 10' })).json).toMatchObject({ error: { code: 'cloud.shops.errors.limit' } })
    expect((await createShop(a.token, { name: 'x' })).status).toBe(400)
  })

  it('only an owner creates shops; a cashier can work in two shops', async () => {
    const a = await onboard('A biznes')
    const c = await onboard('C biznes')
    const kassir = tgUser('Kassir')
    for (const o of [a, c]) {
      const link = (await call('/api/staff/invite', { token: o.token })).json.data.link as string
      const s = await call('/api/session', { body: { initData: await initData(kassir), invite: link.split('inv_')[1] } })
      expect(s.json).toMatchObject({ status: 'ok', user: { role: 'cashier' }, shop: { id: o.shopId } })
    }
    const s = await call('/api/session', { body: { initData: await initData(kassir) } })
    expect(s.json.shops.map((x: any) => x.id).sort()).toEqual([a.shopId, c.shopId].sort())
    expect((await createShop(s.json.token, { name: 'Kassir dokoni' })).status).toBe(403)
    const toA = await switchTo(s.json.token, a.shopId)
    expect(toA.json).toMatchObject({ shop: { id: a.shopId }, user: { role: 'cashier' } })
    expect((await rpc(toA.json.token, 'reportSummary', ['2026-01-01', '2026-12-31'])).status).toBe(403)
  })

  it('copies the catalog (with cost and images) into a new separate shop', async () => {
    const a = await onboard('Nusxa manbai')
    const cat = (await rpc(a.token, 'saveCategory', ['Ichimlik'])).json
    expect(cat.ok).toBe(true)
    const catId = (await rpc(a.token, 'listCategories', [])).json.data[0].id
    const pid = (await rpc(a.token, 'saveProduct', [{ name: 'Cola', price: 9000, cost_price: 7000, category_id: catId, image: webp, barcode: '4780001' }])).json.data
    const b = await createShop(a.token, { name: 'Nusxa', copyFrom: a.shopId })
    const p = (await rpc(b.json.token, 'listProducts', [])).json.data[0]
    expect(p).toMatchObject({ id: pid, name: 'Cola', price: 9000, cost_price: 7000, stock: 0, category_id: catId })
    const img = await call(p.image, { method: 'GET' })
    expect(img.status).toBe(200)
    // Nusxadan keyin mustaqil: manbadagi o'zgarish o'tmaydi.
    await rpc(a.token, 'saveProduct', [{ id: pid, name: 'Cola 1L', price: 9500, cost_price: 7000, category_id: catId }])
    expect((await rpc(b.json.token, 'listProducts', [])).json.data[0].name).toBe('Cola')
  })
})

describe('branch with a shared catalog', () => {
  async function setup() {
    const a = await onboard('Markaz')
    const catId = ((await rpc(a.token, 'saveCategory', ['Telefon'])), (await rpc(a.token, 'listCategories', [])).json.data[0].id)
    const pid = (await rpc(a.token, 'saveProduct', [{ name: 'iPhone 17', price: 15_000_000, cost_price: 12_000_000, category_id: catId, image: webp, barcode: '1111' }])).json.data
    const br = await createShop(a.token, { name: 'Filial', catalogOf: a.shopId })
    expect(br.json).toMatchObject({ shop: { catalogOf: a.shopId, catalogOfName: 'Markaz' } })
    const back = await switchTo(br.json.token, a.shopId)
    return { a: { ...a, token: back.json.token as string }, b: { token: br.json.token as string, id: br.json.shop.id as string }, pid, catId }
  }

  it('starts with the master catalog: same ids, prices, images; own stock and cost', async () => {
    const { b, pid, catId } = await setup()
    const p = (await rpc(b.token, 'listProducts', [])).json.data[0]
    expect(p).toMatchObject({ id: pid, name: 'iPhone 17', price: 15_000_000, stock: 0, category_id: catId, barcode: '1111' })
    expect(p.cost_price).toBe(0)
    expect(p.image).toMatch(new RegExp(`^/img/${b.id}/${pid}/v`))
    const img = await call(p.image, { method: 'GET' })
    expect(img.status).toBe(200)
    expect(img.res.headers.get('Content-Type')).toBe('image/webp')
  })

  it('propagates master edits, keeps branch stock, forbids catalog edits in the branch', async () => {
    const { a, b, pid, catId } = await setup()
    await setStock(b.id, pid, 5)
    await rpc(a.token, 'saveProduct', [{ id: pid, name: 'iPhone 17 Pro', price: 16_000_000, cost_price: 12_000_000, category_id: catId, image: (await rpc(a.token, 'listProducts', [])).json.data[0].image, barcode: '1111' }])
    await rpc(a.token, 'saveProduct', [{ name: 'Chexol', price: 50_000, cost_price: 20_000 }])
    await rpc(a.token, 'bulkAdjustPrices', [{ scope: 'all', mode: 'percent', direction: 'up', value: 10 }])
    const list = (await rpc(b.token, 'listProducts', [])).json.data
    const p = list.find((x: any) => x.id === pid)
    expect(p).toMatchObject({ name: 'iPhone 17 Pro', price: 17_600_000, stock: 5 })
    expect(list.map((x: any) => x.name).sort()).toEqual(['Chexol', 'iPhone 17 Pro'])

    for (const [op, args] of [
      ['saveProduct', [{ name: 'Filialda yangi', price: 1 }]],
      ['saveCategory', ['Yangi']],
      ['setProductActive', [pid, false]],
      ['deleteProduct', [pid]],
      ['bulkAdjustPrices', [{ scope: 'all', mode: 'percent', direction: 'down', value: 5 }]],
    ] as const) {
      expect((await rpc(b.token, op, [...args])).json).toMatchObject({ ok: false, error: { code: 'cloud.shops.errors.catalogManagedByMaster', status: 403 } })
    }
    // Filial kirimi: qoldiq va tannarx o'ziniki; narxni o'zgartirib bo'lmaydi.
    const receipt = (lines: unknown[]) => call('/api/rpc/create_stock_receipt', { token: b.token, body: { args: { request: { lines } } } })
    expect((await receipt([{ productId: pid, qty: 3, costPrice: 13_000_000 }])).status).toBe(200)
    const after = (await rpc(b.token, 'listProducts', [])).json.data.find((x: any) => x.id === pid)
    expect(after).toMatchObject({ stock: 8, price: 17_600_000 })
    expect((await receipt([{ productId: pid, qty: 1, costPrice: 1, salePrice: 1 }])).json)
      .toMatchObject({ error: { code: 'cloud.shops.errors.catalogManagedByMaster' } })
    // Asosiyning tannarxi filial kirimidan o'zgarmaydi.
    expect((await rpc(a.token, 'listProducts', [])).json.data.find((x: any) => x.id === pid).cost_price).toBe(12_000_000)
  })

  it('deletes in the branch, or deactivates when the branch has history', async () => {
    const { a, b, pid } = await setup()
    const free = (await rpc(a.token, 'saveProduct', [{ name: "O'chadi", price: 10 }])).json.data
    await setStock(b.id, pid, 2)
    const shift = (await rpc(b.token, 'openShift', [0])).json.data
    const walkIn = (await rpc(b.token, 'listCustomers', [])).json.data[0]
    const sale = await rpc(b.token, 'createSale', [{ shiftId: shift.id, customerId: walkIn.id, items: [{ product_id: pid, qty: 1, price: 15_000_000 }], paidCash: 15_000_000, paidCard: 0, discount: 0 }])
    expect(sale.status).toBe(200)
    expect((await rpc(a.token, 'deleteProduct', [free])).status).toBe(200)
    expect((await rpc(a.token, 'deleteProduct', [pid])).status).toBe(200) // asosiyda tarixi yo'q
    const list = (await rpc(b.token, 'listProducts', [false])).json.data
    expect(list.find((x: any) => x.id === free)).toBeUndefined()
    expect(list.find((x: any) => x.id === pid)).toMatchObject({ is_active: 0 })
  })

  it('re-sync is a no-op and an out-of-date page cannot overwrite newer data', async () => {
    const { a, b, pid } = await setup()
    const st = await shopDO(b.id).catalogState()
    const old = await shopDO(a.shopId).catalogChanges(0)
    await rpc(a.token, 'saveProduct', [{ id: pid, name: 'Yangi nom', price: 1, cost_price: 0 }])
    // Eski sahifa eski kursor bilan — rad (kursor allaqachon oldinda).
    expect((await shopDO(b.id).applyCatalog(old, 0)).applied).toBe(false)
    expect((await rpc(b.token, 'listProducts', [])).json.data[0].name).toBe('Yangi nom')
    const st2 = await shopDO(b.id).catalogState()
    expect(st2.cursor).toBeGreaterThan(st.cursor)
    // O'zgarishsiz qayta ochish — kursor joyida.
    await call('/api/session', { body: { initData: await initData(a.user) } })
    expect((await shopDO(b.id).catalogState()).cursor).toBe(st2.cursor)
  })

  it('a branch cannot be the catalog source of another branch', async () => {
    const { a, b } = await setup()
    expect((await createShop(a.token, { name: 'Filialning filiali', catalogOf: b.id })).status).toBe(400)
    expect((await createShop(a.token, { name: 'Ikkalasi', catalogOf: a.shopId, copyFrom: a.shopId })).status).toBe(400)
  })
})

describe('bot: choosing the shop for the assistant', () => {
  it('/dokon lists shops; a button switches the active shop', async () => {
    const a = await onboard('Bot A')
    const b = await createShop(a.token, { name: 'Bot B' })
    const hdr = { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }
    await call('/tg/webhook', { body: { message: { chat: { id: a.user.id, type: 'private' }, from: { id: a.user.id }, text: '/dokon' } }, headers: hdr })
    const kb = tg.calls.at(-1)!.body.reply_markup.inline_keyboard.map((r: any) => r[0])
    expect(kb.map((x: any) => x.text)).toEqual(['Bot A', '✅ Bot B'])
    await call('/tg/webhook', { body: { callback_query: { id: 'cb1', from: { id: a.user.id }, data: kb[0].callback_data, message: { chat: { id: a.user.id }, message_id: 5 } } }, headers: hdr })
    expect((await call('/api/session', { body: { initData: await initData(a.user) } })).json.shop.id).toBe(a.shopId)
    // Begona do'kon tugmasi — e'tiborsiz.
    const other = await onboard('Begona bot')
    await call('/tg/webhook', { body: { callback_query: { id: 'cb2', from: { id: a.user.id }, data: `shop:${other.shopId}`, message: { chat: { id: a.user.id }, message_id: 5 } } }, headers: hdr })
    expect((await call('/api/session', { body: { initData: await initData(a.user) } })).json.shop.id).toBe(a.shopId)
    expect(b.status).toBe(200)
  })
})

describe('transfers between shops', () => {
  const transfer = (token: string, body: Record<string, unknown>) => call('/api/transfers/create', { token, body })
  const products = async (token: string) => (await rpc(token, 'listProducts', [false])).json.data as any[]

  it('moves stock with cost between separate shops, matching by barcode or creating the product', async () => {
    const a = await onboard('Ombor')
    // Bulutda qoldiqsiz sotish standart yoqiq — bu test qoldiq tekshiruvini sinaydi.
    await rpc(a.token, 'setSetting', ['allow_negative_stock', '0'])
    const pid = (await rpc(a.token, 'saveProduct', [{ name: 'Suv 19L', price: 15_000, cost_price: 9_000, barcode: '4780019' }])).json.data
    const pid2 = (await rpc(a.token, 'saveProduct', [{ name: 'Stakan', price: 500, cost_price: 200 }])).json.data
    await setStock(a.shopId, pid, 50)
    await setStock(a.shopId, pid2, 10)
    const b = await createShop(a.token, { name: 'Savdo nuqta' })
    const bId = b.json.shop.id as string
    const bPid = (await rpc(b.json.token, 'saveProduct', [{ name: 'Suv (19 litr)', price: 16_000, cost_price: 0, barcode: '4780019' }])).json.data
    const aTok = (await switchTo(b.json.token, a.shopId)).json.token as string

    // Yetarli qoldiq yo'q — hech narsa o'zgarmaydi.
    const bad = await transfer(aTok, { id: 'tr-insufficient-1', toShopId: bId, items: [{ productId: pid, qty: 51 }] })
    expect(bad.json).toMatchObject({ ok: false, error: { code: 'cloud.transfers.errors.insufficientStock' } })
    expect((await products(aTok)).find((x) => x.id === pid).stock).toBe(50)

    const r = await transfer(aTok, { id: 'tr-0001-abcdef', toShopId: bId, note: 'Haftalik', items: [{ productId: pid, qty: 20 }, { productId: pid2, qty: 4 }] })
    expect(r.json).toMatchObject({ ok: true, data: { status: 'done', direction: 'out', peer_name: 'Savdo nuqta', total_cost: 20 * 9_000 + 4 * 200 } })
    // Takror (tarmoq uzildi deb) — ikkinchi harakat yo'q.
    expect((await transfer(aTok, { id: 'tr-0001-abcdef', toShopId: bId, items: [{ productId: pid, qty: 20 }] })).json.data.status).toBe('done')

    const srcList = await products(aTok)
    expect(srcList.find((x) => x.id === pid).stock).toBe(30)
    expect(srcList.find((x) => x.id === pid2).stock).toBe(6)
    const dst = await products(b.json.token)
    expect(dst.find((x) => x.id === bPid)).toMatchObject({ stock: 20, cost_price: 9_000, price: 16_000 }) // shtrix-kod bo'yicha, narx o'zgarmaydi
    expect(dst.find((x) => x.name === 'Stakan')).toMatchObject({ stock: 4, cost_price: 200, price: 500 }) // yangi yaratildi
    // Qabul tomonda kirim; uni alohida bekor qilib bo'lmaydi.
    const rec = (await call('/api/rpc/listStockReceipts', { token: b.json.token, body: { args: [{}] } })).json.data
    expect(rec[0]).toMatchObject({ supplier: '↔ Ombor' })
    expect((await call('/api/rpc/void_stock_receipt', { token: b.json.token, body: { args: { receiptId: rec[0].id } } })).json)
      .toMatchObject({ error: { code: 'cloud.transfers.errors.cannotVoid' } })
    // Ikkala tomonda tarix.
    expect((await call('/api/transfers/list', { token: b.json.token, body: {} })).json.data[0]).toMatchObject({ id: 'tr-0001-abcdef', direction: 'in', peer_name: 'Ombor' })
  })

  it('uses the same product ids with a branch; a product missing from the branch catalog is refused before stock moves', async () => {
    const a = await onboard('Markaz ombor')
    const pid = (await rpc(a.token, 'saveProduct', [{ name: 'Telefon', price: 5_000_000, cost_price: 4_000_000 }])).json.data
    await setStock(a.shopId, pid, 5)
    const br = await createShop(a.token, { name: 'Filial 1', catalogOf: a.shopId })
    const brId = br.json.shop.id as string
    const aTok = (await switchTo(br.json.token, a.shopId)).json.token as string
    const r = await transfer(aTok, { id: 'tr-branch-0001', toShopId: brId, items: [{ productId: pid, qty: 2 }] })
    expect(r.json.data.status).toBe('done')
    expect((await products(br.json.token)).find((x) => x.id === pid)).toMatchObject({ stock: 2, cost_price: 4_000_000 })
    // Filialdan alohida do'konga: filialdagi tovar katalogda bor — qaytarib yuborish ham ishlaydi.
    const back = await transfer(br.json.token, { id: 'tr-branch-0002', toShopId: a.shopId, items: [{ productId: pid, qty: 1 }] })
    expect(back.json.data.status).toBe('done')
    expect((await products(aTok)).find((x) => x.id === pid).stock).toBe(4)

    // Boshqa alohida do'kondan filialga: filial katalogida yo'q tovar — rad, manba qoldig'i joyida.
    const c = await createShop(aTok, { name: 'Boshqa' })
    const cPid = (await rpc(c.json.token, 'saveProduct', [{ name: 'Faqat C da', price: 1, cost_price: 1 }])).json.data
    await setStock(c.json.shop.id, cPid, 3)
    const no = await transfer(c.json.token, { id: 'tr-branch-0003', toShopId: brId, items: [{ productId: cPid, qty: 1 }] })
    expect(no.json).toMatchObject({ ok: false, error: { code: 'cloud.transfers.errors.notInCatalog' } })
    expect((await products(c.json.token))[0].stock).toBe(3)
  })

  it('a pending transfer (receiving step lost) is delivered once by the alarm or by a retried request', async () => {
    const a = await onboard('Pending manba')
    const pid = (await rpc(a.token, 'saveProduct', [{ name: 'Un', price: 100, cost_price: 80 }])).json.data
    await setStock(a.shopId, pid, 10)
    const b = await createShop(a.token, { name: 'Pending qabul' })
    const bId = b.json.shop.id as string
    const aTok = (await switchTo(b.json.token, a.shopId)).json.token as string
    // Qabul a qadami yetib bormagan holat: faqat manbada chiqim.
    const actor = { uid: a.user.id, role: 'owner' as const, name: 'Ega' }
    const out = await shopDO(a.shopId).transferOut(actor, { id: 'tr-pending-0001', peer: bId, peerName: 'Pending qabul', input: [{ productId: pid, qty: 3 }], targets: [{ targetProductId: null }], note: null })
    expect(out).toMatchObject({ ok: true, data: { status: 'pending' } })
    expect((await products(aTok))[0].stock).toBe(7)
    const { runDurableObjectAlarm } = await import('cloudflare:test')
    expect(await runDurableObjectAlarm(shopDO(a.shopId))).toBe(true)
    expect((await call('/api/transfers/list', { token: aTok, body: {} })).json.data[0]).toMatchObject({ id: 'tr-pending-0001', status: 'done' })
    await runDurableObjectAlarm(shopDO(a.shopId))
    expect((await products(b.json.token))[0]).toMatchObject({ name: 'Un', stock: 3, cost_price: 80 })

    // Ikkinchisi — klient o'sha id bilan qayta yuborsa davom etadi (qoldiq ikkinchi marta kamaymaydi).
    await shopDO(a.shopId).transferOut(actor, { id: 'tr-pending-0002', peer: bId, peerName: 'Pending qabul', input: [{ productId: pid, qty: 2 }], targets: [{ targetProductId: null }], note: null })
    const again = await transfer(aTok, { id: 'tr-pending-0002', toShopId: bId, items: [{ productId: pid, qty: 2 }] })
    expect(again.json).toMatchObject({ ok: true, data: { status: 'done' } })
    expect((await products(aTok))[0].stock).toBe(5)
    expect((await products(b.json.token))[0].stock).toBe(5)
  })

  it('only between own shops of one business', async () => {
    const a = await onboard('Mening')
    const pid = (await rpc(a.token, 'saveProduct', [{ name: 'X', price: 1, cost_price: 1 }])).json.data
    await setStock(a.shopId, pid, 5)
    const other = await onboard('Begona biznes')
    expect((await transfer(a.token, { id: 'tr-foreign-001', toShopId: other.shopId, items: [{ productId: pid, qty: 1 }] })).status).toBe(403)
    expect((await transfer(a.token, { id: 'tr-self-00001', toShopId: a.shopId, items: [{ productId: pid, qty: 1 }] })).status).toBe(400)
    expect((await transfer(a.token, { id: 'x', toShopId: other.shopId, items: [] })).status).toBe(400)
  })
})

describe('business report', () => {
  it('sums own shops of the current business; a cashier or a foreign shop is not included', async () => {
    const a = await onboard('Hisobot A')
    const today = new Date().toISOString().slice(0, 10)
    async function sell(token: string, shopId: string, price: number, cost: number, qty: number, debt = 0) {
      const pid = (await rpc(token, 'saveProduct', [{ name: `T${price}`, price, cost_price: cost }])).json.data
      await setStock(shopId, pid, 100)
      const shift = (await rpc(token, 'openShift', [0])).json.data
      const walkIn = (await rpc(token, 'listCustomers', [])).json.data[0]
      const r = await rpc(token, 'createSale', [{ shiftId: shift.id, customerId: walkIn.id, items: [{ product_id: pid, qty, price }], paidCash: price * qty - debt, paidCard: 0, discount: 0 }])
      expect(r.status).toBe(200)
    }
    await sell(a.token, a.shopId, 10_000, 6_000, 3)
    const b = await createShop(a.token, { name: 'Hisobot B' })
    await sell(b.json.token, b.json.shop.id, 5_000, 2_000, 2)
    const other = await onboard('Begona hisobot')
    await sell(other.token, other.shopId, 1_000, 1, 1)

    const r = await call('/api/group/report', { token: b.json.token, body: { from: today, to: today } })
    expect(r.json.data.shops.map((x: any) => x.name)).toEqual(['Hisobot A', 'Hisobot B'])
    expect(r.json.data.total).toMatchObject({ count: 2, total: 40_000, profit: 3 * 4_000 + 2 * 3_000, stockCost: 97 * 6_000 + 98 * 2_000 })
    expect((await call('/api/group/report', { token: b.json.token, body: { from: today, to: '2020-01-01' } })).status).toBe(400)

    const link = (await call('/api/staff/invite', { token: b.json.token })).json.data.link as string
    const kassir = await call('/api/session', { body: { initData: await initData(tgUser('K')), invite: link.split('inv_')[1] } })
    expect((await call('/api/group/report', { token: kassir.json.token, body: { from: today, to: today } })).status).toBe(403)
  })
})
