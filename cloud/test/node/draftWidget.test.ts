import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { OWNER, freshShop, openShiftSql, seedProduct } from './helpers'
import { draftWidgetCaption, draftWidgetData, draftWidgetHtml, widgetRow } from '../../src/telegram/draftWidget'
import { applyEdits, applyGroup, cancelGroup, createDraft, groupDrafts, type Draft } from '../../src/shop/assistant'
import type { Extraction } from '../../src/assistant/ai'
import { dispatch } from '../../src/shop/rpc'
import { OPS } from '../../src/shop/ops'

// Bot tasdiqlash kartasi — Telegram widget chegaralari (sendWidget): html ≤32768 bayt va zlib(9) ≤4096; chat_data ≤1024.

const NOW = new Date().toISOString()
const X = (p: Partial<Extraction>): Extraction => ({
  action: 'unknown', customer: null, items: [], people: [], amount: null, method: null, paid: null,
  category: null, supplier: null, note: null, language: 'uz', currency: null, question: null, revises: false, rate: null, report: null, period: null, ...p,
})
const issue = (i: Draft['issues'][number]) => i.code
const run = (shop: ReturnType<typeof freshShop>) => (op: string, args: unknown, key: string) =>
  dispatch(shop.sql, OPS, op, args, OWNER, { idempotencyKey: key, subscriptionActive: true })

describe('draft widget card', () => {
  for (const lang of ['uz', 'ru'] as const) {
    it(`${lang}: html fits the limits, is valid JS and loads nothing from the network`, () => {
      const html = draftWidgetHtml(lang)
      const bytes = Buffer.from(html, 'utf8')
      expect(bytes.length).toBeLessThanOrEqual(32768)
      expect(deflateSync(bytes, { level: 9 }).length).toBeLessThanOrEqual(4096)
      expect(html).not.toMatch(/\bsrc=|https?:\/\/|@import|@font-face|fetch\(|__T__|<input|<select|<textarea/)
      const code = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? ''
      // eslint-disable-next-line no-new-func
      expect(() => new Function(code)).not.toThrow()
      // Foydalanuvchi matni (mijoz/tovar nomi) faqat textContent bilan — innerHTML faqat tozalash uchun.
      expect(code.match(/innerHTML=(?!"")/g)).toBeNull()
      expect(code).toContain('\\B(?=(\\d{3})+(?!\\d))')
      // Chizishdagi xato kartani «Widget stopped» qilmaydi — ushlanib kartaning o'zida ko'rinadi.
      expect(code).toContain('function draw(){try{dr()}catch(e){oops(e)}}')
      // macOS Telegram 2026-11-12 shu kartada yiqildi (telefon emas): faqat Varonka/Savdo'da sinalgan konstruksiyalar.
      const css = /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? ''
      expect(css).not.toMatch(/(^|[\s,}])#[\w-]+\s*\{|background:none|opacity|flex-wrap|grid-column|repeat\(|rgba\(|hsla\(/)
      expect(code).not.toMatch(/childNodes|children|stopPropagation|addEventListener/)
      // Bosish faqat <button>'da: onclick yagona joyda — bt() ichida.
      expect(code.match(/\.onclick=/g)).toHaveLength(1)
      expect(code).toContain('function bt(x,c,f){var b=el("button",c,x);b.onclick=')
      // So'rovlar 64 baytdan oshmaydi: eng uzuni — tovar narxi ("yi:<16>:<2>:v:<12>.<4>").
      expect(new TextEncoder().encode(`yi:${'a'.repeat(16)}:12:v:123456789012.1234`).length).toBeLessThanOrEqual(64)
    })
  }

  it('one row per action with what can be edited; finished rows show the result', () => {
    const shop = freshShop()
    const p25 = seedProduct(shop, { name: 'Samsung 25W zaryadka', price: 80000, cost: 50000, stock: 10 })
    seedProduct(shop, { name: 'Samsung 45W zaryadka', price: 150000, cost: 100000, stock: 3 })
    const ali = shop.ok<number>('saveCustomer', ['Ali aka', null])
    shop.ok('saveCustomer', ['Ali opa', null])
    openShiftSql(shop, OWNER.uid)
    const sale = createDraft(shop.sql, OWNER, { transcript: 's', source: 'bot_text', now: NOW, extraction: X({ action: 'sale', customer: 'Ali', items: [{ product: 'samsung zaryadka', qty: 2, price: null, cost: null, unit: null }], method: 'debt' }) })
    const row = widgetRow({ draft: sale, expired: false }, 'uz', issue, true)
    expect(row).toMatchObject({ i: sale.id, k: 's', s: 'o', n: '«Ali»', cq: 'Ali', m: 'd', pe: 1 })
    expect(row.co!.map((c) => c[1]).sort()).toEqual(['Ali aka', 'Ali opa'])
    expect(row.it![0].slice(0, 5)).toEqual(['samsung zaryadka', 2, null, '', 0])
    expect(row.it![0][5]!.length).toBe(2)
    expect(row.w).toEqual(expect.arrayContaining(['pickCustomer', 'pickProduct']))
    // Kassirga narx tahrirlanmaydi.
    expect(widgetRow({ draft: sale, expired: false }, 'uz', issue, false).pe).toBeUndefined()

    const fixed = applyEdits(shop.sql, OWNER, sale, { customerId: ali, item: { index: 0, productId: p25 } })
    expect(widgetRow({ draft: fixed, expired: false }, 'uz', issue, true)).toMatchObject({ n: 'Ali aka', a: 160_000, it: [['Samsung 25W zaryadka', 2, 80_000, 'dona', 1]] })
    const done = widgetRow({ draft: { ...fixed, status: 'applied', result: { receiptNumber: 'A-7' } }, expired: false }, 'uz', issue, true)
    expect(done).toMatchObject({ s: 's', res: '#A-7' })
    expect(done.w).toBeUndefined()
    expect(widgetRow({ draft: fixed, expired: true }, 'uz', issue, true).s).toBe('e')
    expect(widgetRow({ draft: { ...fixed, status: 'cancelled', replacedBy: 'x' }, expired: false }, 'uz', issue, true).s).toBe('u')
  })

  it('chat_data stays within 1024 bytes: options, item rows and finally rows are dropped', () => {
    const long = 'Очень длинное название товара номер '
    const draft = (i: number): Draft => ({
      id: String(i).padStart(16, 'a'), kind: 'sale', status: 'new', source: 'bot_text', transcript: '', language: 'ru', currency: 'сўм', spokenCurrency: null,
      customerQuery: 'Покупатель ' + i, customerId: null, customerName: null, walkInId: 1,
      customerOptions: [1, 2, 3, 4, 5].map((n) => ({ id: n, name: `${long}${n}`, phone: null, balance: 0 })),
      items: [1, 2, 3, 4, 5, 6].map((n) => ({ query: long + n, productId: null, name: null, unit: null, qty: 999.5, price: 99_999_999.99, cost: null, stock: null, options: [1, 2, 3, 4, 5].map((o) => ({ id: o, name: long + o, unit: 'шт', price: 1, stock: 1 })) })),
      people: [], method: 'debt', paid: 1, amount: null, category: null, supplier: null, note: null, question: null,
      issues: [{ code: 'pickCustomer' }, { code: 'pickProduct' }, { code: 'insufficientStock' }], ready: false, total: 123_456_789.12, allowed: true, result: null, createdAt: NOW,
    })
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ draft: draft(i), expired: false }))
    const raw = draftWidgetData('a'.repeat(16), rows, 'ru', () => 'Длинная причина, почему нельзя сохранить эту операцию прямо сейчас', true, 'сўм', new Date(0))
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(1024)
    const d = JSON.parse(raw)
    expect(d.l.length + (d.more ?? 0)).toBe(8)
    expect(d.l[0].i).toBe('aaaaaaaaaaaaaaa1')
    // Bitta oddiy amal (bitta tovar) — variantlar kesilmaydi.
    const small = { ...draft(1), items: draft(1).items.slice(0, 1) }
    const one = JSON.parse(draftWidgetData('a'.repeat(16), [{ draft: small, expired: false }], 'ru', issue, true, 'сўм', new Date(0)))
    expect(one.l[0].co).toHaveLength(5)
    expect(one.l[0].it[0][5]).toHaveLength(5)
  })

  it('caption: one line for one action, a short list for several', () => {
    const shop = freshShop()
    const a = createDraft(shop.sql, OWNER, { transcript: 'x', source: 'bot_text', now: NOW, extraction: X({ action: 'payment_out', customer: 'Anvar', amount: 500_000 }) })
    const b = createDraft(shop.sql, OWNER, { transcript: 'x', source: 'bot_text', now: NOW, extraction: X({ action: 'expense', amount: 20_000, note: 'taksi' }) })
    const label = (d: Draft) => d.kind
    const money = (n: number) => `${n} so'm`
    expect(draftWidgetCaption([a], 'uz', label, money)).toBe("payment_out · Anvar · 500000 so'm")
    expect(draftWidgetCaption([a, b], 'ru', label, money)).toBe("🧾 Операций: 2: Anvar 500000 so'm, taksi 20000 so'm")
  })
})

describe('draft group (one message, several actions)', () => {
  it('single-item and single-person edits leave the other rows alone', () => {
    const shop = freshShop()
    const p25 = seedProduct(shop, { name: 'Samsung 25W zaryadka', price: 80000, cost: 50000, stock: 10 })
    const air = seedProduct(shop, { name: 'AirPods Pro', price: 550000, cost: 400000, stock: 2 })
    openShiftSql(shop, OWNER.uid)
    const sale = createDraft(shop.sql, OWNER, { transcript: 's', source: 'bot_text', now: NOW, extraction: X({ action: 'sale', items: [
      { product: 'Samsung 25W zaryadka', qty: 1, price: null, cost: null, unit: null }, { product: 'noma\'lum narsa', qty: 1, price: null, cost: null, unit: null },
      { product: 'AirPods Pro', qty: 1, price: null, cost: null, unit: null }], method: 'cash' }) })
    expect(sale.items.map((i) => i.productId)).toEqual([p25, null, air])
    // Bitta qatorni o'zgartirish — aniqlanmagan qator yo'qolmaydi (to'liq ro'yxat tahriri uni tashlab yuborardi).
    const q = applyEdits(shop.sql, OWNER, sale, { item: { index: 2, qty: 2 } })
    expect(q.items.map((i) => [i.productId, i.qty])).toEqual([[p25, 1], [null, 1], [air, 2]])
    const priced = applyEdits(shop.sql, OWNER, q, { item: { index: 0, price: 75_000 } })
    expect(priced.items[0]).toMatchObject({ price: 75_000, said: false })
    const removed = applyEdits(shop.sql, OWNER, priced, { item: { index: 1, qty: 0 } })
    expect(removed.items.map((i) => i.productId)).toEqual([p25, air])
    expect(removed).toMatchObject({ ready: true, total: 75_000 + 2 * 550_000 })
    // Noto'g'ri indeks — hech narsa o'zgarmaydi.
    expect(applyEdits(shop.sql, OWNER, removed, { item: { index: 9, qty: 5 } }).items).toEqual(removed.items)

    const people = createDraft(shop.sql, OWNER, { transcript: 'p', source: 'bot_text', now: NOW, extraction: X({ action: 'customer', people: [
      { name: 'Anvar', phone: null, owes: 100, owed: null }, { name: 'Botir', phone: null, owes: null, owed: null }] }) })
    const p2 = applyEdits(shop.sql, OWNER, people, { person: { index: 1, amount: 300 } })
    expect(p2.people.map((p) => [p.name, p.kind, p.amount])).toEqual([['Anvar', 'debt', 100], ['Botir', 'debt', 300]])
    expect(applyEdits(shop.sql, OWNER, p2, { person: { index: 0, remove: true } }).people.map((p) => p.name)).toEqual(['Botir'])
  })

  it('confirm all: nothing is written while a row is not ready; then each row once; cancel all', () => {
    const shop = freshShop()
    const ali = shop.ok<number>('saveCustomer', ['Ali', null])
    const first = createDraft(shop.sql, OWNER, { transcript: 'm', source: 'bot_text', now: NOW, extraction: X({ action: 'payment_out', customer: 'Ali', amount: 100 }) })
    const second = createDraft(shop.sql, OWNER, { transcript: 'm', source: 'bot_text', now: NOW, extraction: X({ action: 'payment_in', amount: 40 }), partOf: first.id })
    const third = createDraft(shop.sql, OWNER, { transcript: 'm', source: 'bot_text', now: NOW, extraction: X({ action: 'expense', amount: 5 }), partOf: first.id })
    expect(groupDrafts(shop.sql, OWNER, first.id, NOW).map((r) => r.draft.id)).toEqual([first.id, second.id, third.id])
    // Begona guruh yoki boshqa odam — bo'sh.
    expect(groupDrafts(shop.sql, { ...OWNER, uid: 999 }, first.id, NOW)).toEqual([])
    expect(groupDrafts(shop.sql, OWNER, 'zz', NOW)).toEqual([])

    const blocked = applyGroup(shop.sql, OWNER, first.id, NOW, run(shop))
    expect(blocked).toMatchObject({ ok: false, notReady: [{ index: 1 }] })
    expect(shop.ok('getCustomer', [ali]).balance).toBe(0)

    shop.sql.run('UPDATE assistant_drafts SET draft = ? WHERE id = ?', JSON.stringify(applyEdits(shop.sql, OWNER, second, { customerId: ali })), second.id)
    const ok = applyGroup(shop.sql, OWNER, first.id, NOW, run(shop))
    expect(ok.ok && ok.results.map((r) => r.error)).toEqual([null, null, null])
    expect(shop.ok('getCustomer', [ali]).balance).toBe(-60)
    expect(applyGroup(shop.sql, OWNER, first.id, NOW, run(shop))).toMatchObject({ ok: true, results: [] }) // takror — yozuv yo'q
    expect(shop.ok('getCustomer', [ali]).balance).toBe(-60)

    const g2 = createDraft(shop.sql, OWNER, { transcript: 'n', source: 'bot_text', now: NOW, extraction: X({ action: 'expense', amount: 7 }) })
    expect(cancelGroup(shop.sql, OWNER, g2.id, NOW).map((r) => r.draft.status)).toEqual(['cancelled'])
  })
})
