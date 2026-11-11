import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, initData, mockTelegram, onboard, rpc, shopDO, tg, tgUser } from './helpers'

// Egaga "Savdo" kartasi (salesWidget.ts): /hisobot → sendWidget; karta so'rovi `r:<do'kon>:<t|y|w|m>`.
mockTelegram()

const hdr = { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }
const hook = (body: Record<string, unknown>) => call('/tg/webhook', { body, headers: hdr })
const say = (user: { id: number; language_code?: string }, text: string) =>
  hook({ message: { message_id: 9, chat: { id: user.id, type: 'private' }, from: { ...user, first_name: 'X' }, text } })
const query = (from: number, data: string) => hook({
  widget_query: { id: 'wq', from: { id: from, first_name: 'X' }, chat: { id: from, type: 'private' }, message_id: 77, chat_instance: '1', type: { type: 'data' }, data },
})
const sent = () => tg.calls.find((c) => c.method === 'sendWidget')

async function shopWithSale(name: string, user = tgUser('Ega')) {
  const o = await onboard(name, user)
  await rpc(o.token, 'saveProduct', [{ name: 'Choy', price: 5000 }])
  const pid = ((await rpc(o.token, 'listProducts', [])).json.data as { id: number; name: string }[]).find((p) => p.name === 'Choy')!.id
  await runInDurableObject(shopDO(o.shopId), (_i, state) => { state.storage.sql.exec('UPDATE products SET stock = 100, cost_price = 3000 WHERE id = ?', pid) })
  const shift = (await rpc(o.token, 'openShift', [0])).json.data
  const walkIn = (await rpc(o.token, 'listCustomers', [])).json.data[0]
  const sale = { shiftId: shift.id, customerId: walkIn.id, items: [{ product_id: pid, qty: 2, price: 5000 }], paidCash: 6000, paidCard: 4000, discount: 0 }
  expect((await rpc(o.token, 'createSale', [sale])).status).toBe(200)
  return o
}

describe('owner sales card (widget)', () => {
  it('/hisobot sends a live card for the current shop with the same numbers as the report page', async () => {
    const o = await shopWithSale('Choyxona')
    tg.calls = []
    await say(o.user, '/hisobot')
    const w = sent()!
    expect(w.body).toMatchObject({ chat_id: o.user.id, allow_queries: true })
    expect(w.body.html).toContain('"Bugun"')
    expect(w.body.caption).toBe("🧾 Choyxona · Bugun: savdo 10 000 so'm, 1 ta chek, foyda 4 000 so'm.")
    expect(w.body.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://kassa.test/reports')
    const d = JSON.parse(w.body.chat_data)
    expect(d).toMatchObject({ s: o.shopId, p: 't', n: 'Choyxona', c: "so'm", t: [['Choy', 10000]] })
    expect(d.v).toEqual([10000, 1, 4000, 6000, 4000, 0, 0, 0, 0, 0])
    expect(d.w).toHaveLength(7)
    expect(d.w[6]).toBe(10000)

    // Hisobot sahifasidagi op bilan bir xil (formula bitta).
    const today = new Date().toISOString().slice(0, 10)
    const rep = (await rpc(o.token, 'businessSummary', [today, today])).json.data
    expect([rep.total, rep.count, rep.profit, rep.cash, rep.card]).toEqual(d.v.slice(0, 5))
  })

  it('russian Telegram gets a russian card', async () => {
    const o = await shopWithSale('Магазин', { ...tgUser('Ru'), language_code: 'ru' })
    tg.calls = []
    await say(o.user, '/hisobot')
    expect(sent()!.body.html).toContain('"Сегодня"')
    expect(sent()!.body.caption).toMatch(/^🧾 Магазин · Сегодня: продажи 10 000 so'm, чеков: 1/)
  })

  it('the owner taps a period → answered first, then the card data is replaced', async () => {
    const o = await shopWithSale('Davr')
    tg.calls = []
    await query(o.user.id, `r:${o.shopId}:w`)
    expect(tg.calls.map((c) => c.method)).toEqual(['answerWidgetQuery', 'editMessageWidgetData'])
    expect(tg.calls[0].body).toEqual({ widget_query_id: 'wq', data: 'ok' })
    expect(tg.calls[1].body).toMatchObject({ chat_id: o.user.id, message_id: 77 })
    const d = JSON.parse(tg.calls[1].body.chat_data)
    expect(d).toMatchObject({ p: 'w', s: o.shopId })
    expect(d.v[0]).toBe(10000)
  })

  it('cashiers, strangers, other shops and bad data get no card and no data', async () => {
    const o = await shopWithSale('Himoya')
    const other = await onboard('Boshqa', tgUser('Boshqa'))
    const inv = await call('/api/staff/invite', { token: o.token })
    const cashier = tgUser('Kassir')
    await call('/api/session', { body: { initData: await initData(cashier), invite: inv.json.data.link.split('inv_')[1] } })

    tg.calls = []
    await say(cashier, '/hisobot')
    expect(sent()).toBeUndefined()
    expect(tg.calls.at(-1)!.body.text).toContain('faqat do\'kon egasi')

    const stranger = tgUser('Begona')
    tg.calls = []
    await say(stranger, '/hisobot')
    expect(sent()).toBeUndefined()

    for (const [from, data, answer] of [
      [cashier.id, `r:${o.shopId}:t`, 'forbidden'],
      [other.user.id, `r:${o.shopId}:t`, 'forbidden'], // boshqa do'kon egasi
      [stranger.id, `r:${o.shopId}:t`, 'forbidden'],
      [o.user.id, `r:${o.shopId}:x`, 'bad'],
      [o.user.id, 'r:abc:t', 'bad'],
      [o.user.id, 'zz', 'bad'],
    ] as const) {
      tg.calls = []
      await query(from, data)
      expect(tg.calls).toEqual([{ method: 'answerWidgetQuery', body: { widget_query_id: 'wq', data: answer } }])
    }
  })
})
