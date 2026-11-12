import { describe, expect, it } from 'vitest'
import { CASHIER, OWNER, freshShop, openShiftSql, seedProduct, walkInId, type Shop } from './helpers'
import { rank, score } from '../../src/assistant/match'
import { sanitize, systemPrompt, type Extraction } from '../../src/assistant/ai'
import { periodRange } from '../../src/shop/answers'
import { applyDraft, applyEdits, createDraft, fxSaved, historyTurns, loadDraft, type Draft } from '../../src/shop/assistant'
import { dispatch } from '../../src/shop/rpc'
import { chatEntries, deleteChat, listChats, openChat, touchChat } from '../../src/shop/chats'
import { OPS } from '../../src/shop/ops'

// AI yordamchisi: AI faqat matn beradi — moslash, tekshiruv va yozish deterministik (shu yerda).

const NOW = new Date().toISOString()
const X = (p: Partial<Extraction>): Extraction => ({
  action: 'unknown', customer: null, items: [], people: [], amount: null, method: null, paid: null,
  category: null, supplier: null, note: null, language: 'uz', currency: null, question: null, revises: false, rate: null, report: null, period: null, ...p,
})
const runAs = (shop: Shop, actor: typeof OWNER) => (op: string, args: unknown, key: string) =>
  dispatch(shop.sql, OPS, op, args, actor, { idempotencyKey: key, subscriptionActive: true })

function setup(withCashier = false) {
  const shop = freshShop({ withCashier })
  const p25 = seedProduct(shop, { name: 'Samsung 25W zaryadka', price: 80000, cost: 50000, stock: 10 })
  const p45 = seedProduct(shop, { name: 'Samsung 45W zaryadka', price: 150000, cost: 100000, stock: 3 })
  const air = seedProduct(shop, { name: 'AirPods Pro', price: 550000, cost: 400000, stock: 2 })
  const bahrom = shop.ok<number>('saveCustomer', ["Bahrom do'kon", '+998901234567'])
  return { shop, p25, p45, air, bahrom }
}

describe('matching', () => {
  it('is script-insensitive and strict about model numbers', () => {
    expect(score('самсунг зарядка', 'Samsung 25W zaryadka')).toBeGreaterThan(0.6)
    expect(score('Samsung 25W', 'Samsung 25W zaryadka')).toBeGreaterThan(score('Samsung 25W', 'Samsung 45W zaryadka'))
    expect(score('Samsung 25W', 'Samsung 45W zaryadka')).toBeLessThan(0.5)
    const items = ['Samsung 25W zaryadka', 'Samsung 45W zaryadka', 'AirPods Pro']
    expect(rank('airpods', items, (x) => x).confident).toBe(true)
    expect(rank('samsung zaryadka', items, (x) => x).confident).toBe(false)
    expect(rank('Бахром', ["Bahrom do'kon", 'Shahbozbek'], (x) => x).top[0].item).toBe("Bahrom do'kon")
  })

  it('sanitizes any model output into a strict shape', () => {
    expect(sanitize('nonsense').action).toBe('unknown')
    const x = sanitize({ action: 'sale', items: [{ product: ' Kola ', qty: '2', price: -5, cost: null, unit: null }, { qty: 1 }], amount: '1 500', method: 'bitcoin' })
    expect(x).toMatchObject({ action: 'sale', items: [{ product: 'Kola', qty: 2, price: null, cost: null, unit: null }], amount: 1500, method: null })
  })
})

describe('drafts', () => {
  it('sale on credit: resolves customer and product across scripts, applies once', () => {
    const { shop, p25, bahrom } = setup()
    openShiftSql(shop, OWNER.uid)
    const d = createDraft(shop.sql, OWNER, {
      transcript: 'Бахромга 2 та самсунг 25W зарядка қарзга', source: 'text', now: NOW,
      extraction: X({ action: 'sale', customer: 'Бахром', items: [{ product: 'Samsung 25W zaryadka', qty: 2, price: null, cost: null, unit: null }], method: 'debt' }),
    })
    expect(d).toMatchObject({ kind: 'sale', customerId: bahrom, ready: true, total: 160000, method: 'debt' })
    expect(d.items[0]).toMatchObject({ productId: p25, qty: 2, price: 80000 })
    expect(shop.sql.get<{ c: number }>('SELECT COUNT(*) c FROM sales')!.c).toBe(0) // qoralama — yozuv yo'q

    const a = applyDraft(shop.sql, OWNER, d.id, null, NOW, runAs(shop, OWNER))
    expect(a.ok).toBe(true)
    const again = applyDraft(shop.sql, OWNER, d.id, null, NOW, runAs(shop, OWNER))
    expect(again.ok).toBe(true)
    expect(shop.sql.get<{ c: number }>('SELECT COUNT(*) c FROM sales')!.c).toBe(1)
    expect(shop.sql.get<{ balance: number }>('SELECT balance FROM customers WHERE id = ?', bahrom)!.balance).toBe(-160000)
    expect(shop.sql.get<{ stock: number }>('SELECT stock FROM products WHERE id = ?', p25)!.stock).toBe(8)
    expect((again as { draft: Draft }).draft.result).toMatchObject({ total: 160000, debt: 160000 })
  })

  it('does not trust a model number the user never said — asks to pick, then applies the pick', () => {
    const { shop, p45 } = setup()
    openShiftSql(shop, OWNER.uid)
    const d = createDraft(shop.sql, OWNER, {
      transcript: '1 ta samsung zaryadka naqd', source: 'voice', now: NOW,
      extraction: X({ action: 'sale', items: [{ product: 'Samsung 25W zaryadka', qty: 1, price: null, cost: null, unit: null }], method: 'cash' }),
    })
    expect(d.ready).toBe(false)
    expect(d.issues[0].code).toBe('pickProduct')
    expect(d.items[0].options.map((o) => o.name)).toEqual(expect.arrayContaining(['Samsung 25W zaryadka', 'Samsung 45W zaryadka']))
    const fixed = applyEdits(shop.sql, OWNER, d, { items: [{ productId: p45, qty: 1 }] })
    expect(fixed).toMatchObject({ ready: true, total: 150000 })
    expect(applyDraft(shop.sql, OWNER, d.id, { items: [{ productId: p45, qty: 1 }] }, NOW, runAs(shop, OWNER)).ok).toBe(true)
    expect(shop.sql.get<{ paid_cash: number }>('SELECT paid_cash FROM sales')!.paid_cash).toBe(150000)
  })

  it('blocks what the data does not allow: walk-in debt, no shift, short stock', () => {
    const { shop } = setup()
    const noShift = createDraft(shop.sql, OWNER, {
      transcript: '3 ta airpods qarzga', source: 'text', now: NOW,
      extraction: X({ action: 'sale', items: [{ product: 'AirPods Pro', qty: 3, price: null, cost: null, unit: null }], method: 'debt' }),
    })
    expect(noShift.issues.map((i) => i.code).sort()).toEqual(['debtNeedsCustomer', 'insufficientStock', 'shiftNotOpen'])
    const r = applyDraft(shop.sql, OWNER, noShift.id, null, NOW, runAs(shop, OWNER))
    expect(r).toMatchObject({ ok: false, error: { code: 'cloud.ai.errors.notReady' } })
    expect(shop.sql.get<{ c: number }>('SELECT COUNT(*) c FROM sales')!.c).toBe(0)
  })

  it('cashier: only sales, and only at catalog prices', () => {
    const { shop, p25 } = setup(true)
    openShiftSql(shop, CASHIER.uid)
    const exp = createDraft(shop.sql, CASHIER, { transcript: 'ijaraga 2 mln', source: 'text', now: NOW, extraction: X({ action: 'expense', amount: 2_000_000, category: 'ijara' }) })
    expect(exp.issues[0].code).toBe('notAllowed')
    const sale = createDraft(shop.sql, CASHIER, {
      transcript: 'samsung 25w zaryadka 1 ta 60 mingga', source: 'text', now: NOW,
      extraction: X({ action: 'sale', items: [{ product: 'Samsung 25W zaryadka', qty: 1, price: 60000, cost: null, unit: null }], method: 'cash' }),
    })
    expect(sale.items[0]).toMatchObject({ productId: p25, price: 80000 })
    expect(applyDraft(shop.sql, CASHIER, sale.id, null, NOW, runAs(shop, CASHIER)).ok).toBe(true)
    // Boshqa odamning qoralamasi ko'rinmaydi.
    expect(loadDraft(shop.sql, OWNER, sale.id, NOW)).toBeNull()
  })

  it('payment from a customer, expense with a mapped category, stock receipt with weighted cost', () => {
    const { shop, p25, bahrom } = setup()
    const run = runAs(shop, OWNER)
    const pay = createDraft(shop.sql, OWNER, { transcript: 'Bahrom paid 50k cash', source: 'text', now: NOW, extraction: X({ action: 'payment_in', customer: 'Bahrom', amount: 50000, method: 'cash' }) })
    expect(pay.ready).toBe(true)
    expect(applyDraft(shop.sql, OWNER, pay.id, null, NOW, run).ok).toBe(true)
    expect(shop.sql.get<{ balance: number }>('SELECT balance FROM customers WHERE id = ?', bahrom)!.balance).toBe(50000)

    const exp = createDraft(shop.sql, OWNER, { transcript: 'Ижарага 2 млн бердим', source: 'text', now: NOW, extraction: X({ action: 'expense', amount: 2_000_000, category: 'ijara', note: 'Noyabr ijarasi' }) })
    expect(exp).toMatchObject({ ready: true, category: 'Ijara' })
    expect(applyDraft(shop.sql, OWNER, exp.id, null, NOW, run).ok).toBe(true)
    expect(shop.sql.get('SELECT amount, category, note FROM expenses')).toMatchObject({ amount: 2_000_000, category: 'Ijara', note: 'Noyabr ijarasi' })

    const rec = createDraft(shop.sql, OWNER, {
      transcript: "Ali akadan 10 ta Samsung 25W zaryadka keldi 60 mingdan", source: 'text', now: NOW,
      extraction: X({ action: 'receipt', supplier: 'Ali aka', items: [{ product: 'Samsung 25W zaryadka', qty: 10, price: 60000, cost: null, unit: null }] }),
    })
    expect(rec).toMatchObject({ ready: true, total: 600000 })
    const r = applyDraft(shop.sql, OWNER, rec.id, null, NOW, run)
    expect(r.ok && r.draft.result).toMatchObject({ receiptNumber: 'K-00001', total: 600000 })
    // 10 × 50 000 + 10 × 60 000 → 55 000
    expect(shop.sql.get('SELECT stock, cost_price FROM products WHERE id = ?', p25)).toMatchObject({ stock: 20, cost_price: 55000 })
  })

  it('new products: created together with opening stock in one transaction; duplicates and nameless asks are blocked', () => {
    const { shop, p25 } = setup(true)
    const run = runAs(shop, OWNER)
    const d = createDraft(shop.sql, OWNER, {
      transcript: 'Yangi tovar: Anker 20W 95 mingdan 10 ta, Baseus kabel 30 mingdan', source: 'text', now: NOW,
      extraction: X({ action: 'product', items: [
        { product: 'Anker 20W zaryadka', qty: 10, price: 95000, cost: 70000, unit: 'dona' },
        { product: 'Baseus kabel', qty: null, price: 30000, cost: null, unit: null },
      ] }),
    })
    expect(d).toMatchObject({ kind: 'product', ready: true })
    expect(d.items.map((i) => [i.name, i.qty, i.price, i.cost, i.unit])).toEqual([['Anker 20W zaryadka', 10, 95000, 70000, 'dona'], ['Baseus kabel', 0, 30000, null, 'dona']])
    const r = applyDraft(shop.sql, OWNER, d.id, null, NOW, run)
    expect(r.ok && r.draft.result).toMatchObject({ count: 2 })
    expect(shop.sql.get('SELECT price, cost_price, stock FROM products WHERE name = ?', 'Anker 20W zaryadka')).toMatchObject({ price: 95000, cost_price: 70000, stock: 10 })
    // Qoldiq jurnal orqali ("Davr harakati" buzilmaydi).
    expect(shop.sql.get("SELECT kind, delta FROM stock_adjustments WHERE product_name = 'Anker 20W zaryadka'")).toMatchObject({ kind: 'initial', delta: 10 })
    // Ikki marta tasdiqlash — ikkinchi nusxa yo'q.
    expect(applyDraft(shop.sql, OWNER, d.id, null, NOW, run).ok).toBe(true)
    expect(shop.sql.get<{ c: number }>("SELECT COUNT(*) c FROM products WHERE name = 'Baseus kabel'")!.c).toBe(1)

    const dup = createDraft(shop.sql, OWNER, { transcript: 'yangi tovar samsung', source: 'text', now: NOW, extraction: X({ action: 'product', items: [{ product: 'samsung 25W zaryadka', qty: 1, price: 1, cost: null, unit: null }] }) })
    expect(dup.issues.map((i) => i.code)).toContain('productExists')
    expect(p25).toBeGreaterThan(0)
    const noPrice = createDraft(shop.sql, OWNER, { transcript: 'yangi tovar Kola', source: 'text', now: NOW, extraction: X({ action: 'product', items: [{ product: 'Kola', qty: 5, price: null, cost: null, unit: null }] }) })
    expect(noPrice.issues.map((i) => i.code)).toEqual(['priceMissing'])
    const fixed = applyEdits(shop.sql, OWNER, noPrice, { newItems: [{ name: 'Kola 1L', price: 12000, cost: null, unit: 'dona', qty: 5 }] })
    expect(fixed.ready).toBe(true)
    // "10 ta test mahsulot" — nom yo'q: hech narsa to'qilmaydi.
    const vague = createDraft(shop.sql, OWNER, { transcript: '10 ta test mahsulot qoshib ber', source: 'text', now: NOW, extraction: X({ action: 'product', items: [], question: 'Qaysi tovarlar?' }) })
    expect(vague.issues.map((i) => i.code)).toEqual(['noItems'])
    const cashier = createDraft(shop.sql, CASHIER, { transcript: 'yangi tovar', source: 'text', now: NOW, extraction: X({ action: 'product', items: [{ product: 'Pepsi', qty: 1, price: 9000, cost: null, unit: null }] }) })
    expect(cashier.issues[0].code).toBe('notAllowed')
  })

  it('prices said in another currency are blocked until reviewed; recent messages become context', () => {
    const { shop } = setup()
    const d = createDraft(shop.sql, OWNER, {
      transcript: 'Galaxy S24 Ultra 800 dollar', source: 'voice', now: NOW,
      extraction: X({ action: 'product', currency: 'USD', items: [{ product: 'Galaxy S24 Ultra', qty: 1, price: 800, cost: null, unit: null }] }),
    })
    expect(d.issues).toEqual([{ code: 'currencyMismatch', params: { said: 'USD', shop: "so'm" } }])
    const fixed = applyEdits(shop.sql, OWNER, d, { newItems: [{ name: 'Galaxy S24 Ultra', price: 10_400_000, cost: null, unit: 'dona', qty: 1 }] })
    expect(fixed.ready).toBe(true)
    // Kontekst: oxirgi xabar va yordamchi nimani tushungani.
    const turns = historyTurns(shop.sql, OWNER.uid, new Date(Date.parse(NOW) + 60_000).toISOString())
    expect(turns[0]).toEqual({ role: 'user', text: 'Galaxy S24 Ultra 800 dollar' })
    expect(JSON.parse(turns[1].text)).toMatchObject({ action: 'product', items: [{ product: 'Galaxy S24 Ultra', price: 800 }], currency: 'USD' })
    expect(historyTurns(shop.sql, OWNER.uid, new Date(Date.parse(NOW) + 3600_000).toISOString())).toEqual([])
    expect(historyTurns(shop.sql, CASHIER.uid, NOW)).toEqual([])
  })

  it('new customers with opening balances: debt is negative, credit positive, all in one transaction', () => {
    const { shop } = setup(true)
    const run = runAs(shop, OWNER)
    const d = createDraft(shop.sql, OWNER, {
      transcript: "Uchta mijoz qo'sh: Bahrom aka 3 million qarzi bor, Ma'ruf aka 1 million haqi bor, Dilshod aka 5 million qarzi bor", source: 'voice', now: NOW,
      extraction: X({ action: 'customer', people: [
        { name: 'Bahrom aka', phone: null, owes: 3_000_000, owed: null },
        { name: "Ma'ruf aka", phone: '+998901112233', owes: null, owed: 1_000_000 },
        { name: 'Dilshod aka', phone: null, owes: 5_000_000, owed: null },
      ] }),
    })
    expect(d).toMatchObject({ kind: 'customer', ready: true, total: 8_000_000 })
    expect(d.people.map((p) => [p.name, p.kind, p.amount])).toEqual([['Bahrom aka', 'debt', 3_000_000], ["Ma'ruf aka", 'credit', 1_000_000], ['Dilshod aka', 'debt', 5_000_000]])
    const r = applyDraft(shop.sql, OWNER, d.id, null, NOW, run)
    expect(r.ok && r.draft.result).toMatchObject({ count: 3 })
    const bal = (n: string) => shop.sql.get<{ balance: number; opening_balance: number; phone: string | null }>('SELECT balance, opening_balance, phone FROM customers WHERE name = ?', n)
    expect(bal('Bahrom aka')).toMatchObject({ balance: -3_000_000, opening_balance: -3_000_000 })
    expect(bal("Ma'ruf aka")).toMatchObject({ balance: 1_000_000, phone: '+998901112233' })
    expect(bal('Dilshod aka')).toMatchObject({ balance: -5_000_000 })
    // Ikki marta tasdiqlash — ikkinchi nusxa yo'q.
    expect(applyDraft(shop.sql, OWNER, d.id, null, NOW, run).ok).toBe(true)
    expect(shop.sql.get<{ c: number }>("SELECT COUNT(*) c FROM customers WHERE name = 'Bahrom aka'")!.c).toBe(1)

    // Bunday ism bor yoki ro'yxatda takror — blok; saldo turi tanlangan-u summa yo'q — blok.
    const dup = createDraft(shop.sql, OWNER, { transcript: 'mijoz qoshing', source: 'text', now: NOW, extraction: X({ action: 'customer', people: [{ name: 'bahrom aka', phone: null, owes: null, owed: null }, { name: 'Ali', phone: null, owes: null, owed: null }, { name: 'ali', phone: null, owes: null, owed: null }] }) })
    expect(dup.issues.map((i) => i.code)).toEqual(['customerExists', 'customerExists'])
    const noSum = applyEdits(shop.sql, OWNER, dup, { people: [{ name: 'Vali', phone: null, kind: 'debt', amount: null }] })
    expect(noSum.issues.map((i) => i.code)).toEqual(['amountMissing'])
    const fixed = applyEdits(shop.sql, OWNER, noSum, { people: [{ name: 'Vali', phone: ' ', kind: 'none', amount: 500 }] })
    expect(fixed).toMatchObject({ ready: true, people: [{ name: 'Vali', phone: null, kind: 'none' }] })
    expect(applyDraft(shop.sql, OWNER, fixed.id, { people: fixed.people }, NOW, run).ok).toBe(true)
    expect(bal('Vali')).toMatchObject({ balance: 0 })
    // Nom aytilmasa hech narsa to'qilmaydi; kassir mijoz yarata olmaydi.
    const vague = createDraft(shop.sql, OWNER, { transcript: 'mijoz qoshib ber', source: 'text', now: NOW, extraction: X({ action: 'customer', people: [], question: 'Kimni?' }) })
    expect(vague.issues.map((i) => i.code)).toEqual(['noPeople'])
    const cashier = createDraft(shop.sql, CASHIER, { transcript: 'mijoz qoshing Pepsi aka', source: 'text', now: NOW, extraction: X({ action: 'customer', people: [{ name: 'Pepsi aka', phone: null, owes: null, owed: null }] }) })
    expect(cashier.issues[0].code).toBe('notAllowed')
    // Op o'zi ham dublikatni rad etadi (poyga: qoralamadan keyin mijoz qo'shilgan bo'lsa) — hech biri yozilmaydi.
    expect(run('assistant_create_customers', [{ people: [{ name: 'Yangi', balance: 0 }, { name: 'Dilshod aka', balance: 0 }] }], 'k-dup-customers')).toMatchObject({ ok: false, error: { code: 'cloud.ai.errors.customerExists' } })
    expect(shop.sql.get<{ c: number }>("SELECT COUNT(*) c FROM customers WHERE name = 'Yangi'")!.c).toBe(0)
  })

  it('a correction replaces the open draft in full; the old one can no longer be confirmed', () => {
    const { shop } = setup()
    const run = runAs(shop, OWNER)
    const four = [
      { product: 'iPhone 16 Pro Max', qty: 10, price: 1600, cost: 1500, unit: null },
      { product: 'iPhone 17 Pro Max', qty: 25, price: 1600, cost: 1400, unit: null },
      { product: 'Galaxy S26 Ultra', qty: 22, price: 1100, cost: 1000, unit: null },
      { product: 'S24 Ultra', qty: 10, price: 600, cost: 500, unit: null },
    ]
    const first = createDraft(shop.sql, OWNER, { transcript: '10 ta iPhone 16 Pro Max ...', source: 'bot_voice', now: NOW, extraction: X({ action: 'product', currency: 'USD', items: four }) })
    const later = new Date(Date.parse(NOW) + 30_000).toISOString()
    const fixed = createDraft(shop.sql, OWNER, {
      transcript: "16 deganim yo'q, 18 Pro Max dedim", source: 'bot_voice', now: later,
      extraction: X({ action: 'product', currency: 'USD', revises: true, items: [{ ...four[0], product: 'iPhone 18 Pro Max' }, ...four.slice(1)] }),
    })
    expect(fixed.replaces).toBe(first.id)
    expect(fixed.items.map((i) => i.name)).toEqual(['iPhone 18 Pro Max', 'iPhone 17 Pro Max', 'Galaxy S26 Ultra', 'S24 Ultra'])
    expect(loadDraft(shop.sql, OWNER, first.id, later)).toMatchObject({ status: 'cancelled', replacedBy: fixed.id })
    expect(applyDraft(shop.sql, OWNER, first.id, null, later, run)).toMatchObject({ ok: false, error: { code: 'cloud.ai.errors.draftCancelled' } })
    // Kontekstda: eskisi "replaced", yangisi "open" — tannarx va birlik bilan (keyingi tuzatish to'liq nusxa olsin).
    const turns = historyTurns(shop.sql, OWNER.uid, new Date(Date.parse(NOW) + 60_000).toISOString())
    expect(JSON.parse(turns[1].text)).toMatchObject({ status: 'replaced' })
    expect(JSON.parse(turns[3].text)).toMatchObject({ status: 'open', items: [{ product: 'iPhone 18 Pro Max', qty: 10, price: 1600, cost: 1500, unit: 'dona' }, {}, {}, {}] })
    // Oradagi noto'g'ri tushunilgan boshqa turdagi karta (sotuv) bo'lsa ham — tuzatish shu turdagi (tovar) qoralamani almashtiradi.
    const misheard = createDraft(shop.sql, OWNER, { transcript: 'iPhone 16 Pro Max 1800 dedim', source: 'bot_voice', now: later, extraction: X({ action: 'sale', currency: 'USD', items: [{ product: 'iPhone 16 Pro Max', qty: 1, price: 1800, cost: null, unit: null }] }) })
    const fixed2 = createDraft(shop.sql, OWNER, { transcript: '18 Pro Max dedim', source: 'bot_voice', now: later, extraction: X({ action: 'product', currency: 'USD', revises: true, items: four }) })
    expect(fixed2.replaces).toBe(fixed.id)
    expect(loadDraft(shop.sql, OWNER, misheard.id, later)?.status).toBe('new')
    // Yangi alohida amal (revises=false) ochiq qoralamaga tegmaydi; "tushunmadim" ham almashtirmaydi.
    const other = createDraft(shop.sql, OWNER, { transcript: 'Ijaraga 2 mln', source: 'text', now: later, extraction: X({ action: 'expense', amount: 2_000_000 }) })
    expect(other.replaces).toBeUndefined()
    createDraft(shop.sql, OWNER, { transcript: 'hmm', source: 'text', now: later, extraction: X({ action: 'unknown', revises: true }) })
    expect(loadDraft(shop.sql, OWNER, fixed2.id, later)?.status).toBe('new')
  })

  it('prices said in dollars: renaming keeps the warning; a rate converts only what was said and is remembered', () => {
    const { shop, p25 } = setup()
    const run = runAs(shop, OWNER)
    const d = createDraft(shop.sql, OWNER, {
      transcript: 'Yangi tovar Galaxy S26 Ultra 1100 dollar, tannarxi 1000', source: 'voice', now: NOW,
      extraction: X({ action: 'product', currency: 'USD', items: [{ product: 'Galaxy S26', qty: 2, price: 1100, cost: 1000, unit: null }] }),
    })
    // Faqat nomni tuzatish — narxlar hali dollarda, ogohlantirish qoladi.
    const renamed = applyEdits(shop.sql, OWNER, d, { newItems: [{ name: 'Galaxy S26 Ultra', price: 1100, cost: 1000, unit: 'dona', qty: 2 }] })
    expect(renamed.issues.map((i) => i.code)).toEqual(['currencyMismatch'])
    expect(fxSaved(shop.sql, 'USD', 'UZS')).toBeNull()
    const conv = applyEdits(shop.sql, OWNER, renamed, { rate: 12850.5 })
    expect(conv).toMatchObject({ ready: true, spokenCurrency: null, items: [{ name: 'Galaxy S26 Ultra', price: 14_135_550, cost: 12_850_500 }] })
    expect(fxSaved(shop.sql, 'USD', 'UZS')).toBe(12850.5)
    // Sotuv: aytilgan narx o'tkaziladi, katalogdan olingan so'm narx tegilmaydi.
    const sale = createDraft(shop.sql, OWNER, {
      transcript: 'AirPods Pro 50 dollardan 1 ta, Samsung 25W zaryadka 1 ta', source: 'text', now: NOW,
      extraction: X({ action: 'sale', currency: 'USD', items: [{ product: 'AirPods Pro', qty: 1, price: 50, cost: null, unit: null }, { product: 'Samsung 25W zaryadka', qty: 1, price: null, cost: null, unit: null }], method: 'cash' }),
    })
    const s2 = applyEdits(shop.sql, OWNER, sale, { rate: 12850.5 })
    expect(s2.items.map((i) => [i.name, i.price])).toEqual([['AirPods Pro', 642_525], ['Samsung 25W zaryadka', 80000]])
    expect(p25).toBeGreaterThan(0)
    // Kurs bilan to'g'ridan-to'g'ri tasdiqlash (bot tugmasi shu yo'l bilan).
    const again = createDraft(shop.sql, OWNER, { transcript: 'Yangi tovar Pixel 10 700 dollar', source: 'text', now: NOW, extraction: X({ action: 'product', currency: 'USD', items: [{ product: 'Pixel 10', qty: 1, price: 700, cost: null, unit: null }] }) })
    expect(applyDraft(shop.sql, OWNER, again.id, null, NOW, run).ok).toBe(false)
    expect(applyDraft(shop.sql, OWNER, again.id, { rate: 12900 }, NOW, run).ok).toBe(true)
    expect(shop.sql.get('SELECT price FROM products WHERE name = ?', 'Pixel 10')).toMatchObject({ price: 9_030_000 })
  })

  it('money from a person not in the base: the customer is created on confirm, then the payment is recorded', () => {
    const { shop } = setup(true)
    const run = runAs(shop, OWNER)
    openShiftSql(shop, OWNER.uid)
    const d = createDraft(shop.sql, OWNER, { transcript: 'Abdullohdan 500 ming oldim', source: 'voice', now: NOW, extraction: X({ action: 'payment_in', customer: 'Abdulloh', amount: 500_000, method: 'cash' }) })
    expect(d).toMatchObject({ newCustomer: 'Abdulloh', customerId: null, ready: true })
    const r = applyDraft(shop.sql, OWNER, d.id, null, NOW, run)
    expect(r.ok).toBe(true)
    const c = shop.sql.get<{ id: number; balance: number }>("SELECT id, balance FROM customers WHERE name = 'Abdulloh'")!
    expect(c.balance).toBe(500_000)
    // Takror tasdiq — ikkinchi mijoz ham, ikkinchi to'lov ham yo'q.
    expect(applyDraft(shop.sql, OWNER, d.id, null, NOW, run).ok).toBe(true)
    expect(shop.sql.get<{ c: number }>("SELECT COUNT(*) c FROM customers WHERE name = 'Abdulloh'")!.c).toBe(1)
    expect(shop.sql.get<{ balance: number }>('SELECT balance FROM customers WHERE id = ?', c.id)!.balance).toBe(500_000)

    // O'xshash mijozlar bor — avtomatik yaratilmaydi (dublikat xavfi); ega "yangi sifatida" tanlasa — tayyor.
    shop.ok('saveCustomer', ['Bahrom ota', null])
    const similar = createDraft(shop.sql, OWNER, { transcript: 'Bahromdan 50 ming', source: 'text', now: NOW, extraction: X({ action: 'payment_in', customer: 'Bahrom', amount: 50_000 }) })
    expect(similar.newCustomer).toBeNull()
    expect(similar.issues.map((i) => i.code)).toContain('pickCustomer')
    expect(applyEdits(shop.sql, OWNER, similar, { newCustomer: 'Bahrom aka', customerId: null })).toMatchObject({ newCustomer: 'Bahrom aka', ready: true })
    // Qarzga sotuv yangi mijozga — "yo'l-yo'lakayga qarz" bloki yo'q.
    const sale = createDraft(shop.sql, OWNER, { transcript: 'Sardorga 1 ta AirPods Pro qarzga', source: 'text', now: NOW, extraction: X({ action: 'sale', customer: 'Sardor', items: [{ product: 'AirPods Pro', qty: 1, price: null, cost: null, unit: null }], method: 'debt' }) })
    expect(sale).toMatchObject({ newCustomer: 'Sardor', ready: true })
    expect(applyDraft(shop.sql, OWNER, sale.id, null, NOW, run).ok).toBe(true)
    expect(shop.sql.get<{ balance: number }>("SELECT balance FROM customers WHERE name = 'Sardor'")!.balance).toBe(-550_000)
    // Kassir mijoz yarata olmaydi — avvalgidek tanlash kerak.
    const cashier = createDraft(shop.sql, CASHIER, { transcript: 'Jasurga 1 ta AirPods Pro', source: 'text', now: NOW, extraction: X({ action: 'sale', customer: 'Jasur', items: [{ product: 'AirPods Pro', qty: 1, price: null, cost: null, unit: null }], method: 'cash' }) })
    expect(cashier.newCustomer).toBeNull()
    expect(cashier.issues.map((i) => i.code)).toContain('customerNotFound')
  })

  it('a stated rate converts the said amounts on the spot; a rate-only correction converts the open draft', () => {
    const { shop } = setup()
    const p = createDraft(shop.sql, OWNER, { transcript: "Abdullohdan 500 dollar oldim, dollarni 12 mingdan hisobla", source: 'voice', now: NOW, extraction: X({ action: 'payment_in', customer: 'Abdulloh', amount: 500, currency: 'USD', rate: 12_000 }) })
    expect(p).toMatchObject({ amount: 6_000_000, spokenCurrency: null, ready: true, newCustomer: 'Abdulloh' })
    expect(fxSaved(shop.sql, 'USD', 'UZS')).toBe(12_000)
    // Avval dollarda, keyin alohida xabar: "dollarni 12 500 dan hisobla".
    const later = new Date(Date.parse(NOW) + 20_000).toISOString()
    const open = createDraft(shop.sql, OWNER, { transcript: 'Ijaraga 300 dollar', source: 'voice', now: NOW, extraction: X({ action: 'expense', amount: 300, currency: 'USD', category: 'Ijara' }) })
    expect(open.issues.map((i) => i.code)).toEqual(['currencyMismatch'])
    const fixed = createDraft(shop.sql, OWNER, { transcript: 'dollarni 12 500 dan hisobla', source: 'voice', now: later, extraction: X({ action: 'expense', amount: 300, currency: 'USD', category: 'Ijara', revises: true, rate: 12_500 }) })
    expect(fixed).toMatchObject({ replaces: open.id, amount: 3_750_000, ready: true })
  })

  it('chats: history per chat, context and corrections stay inside the chat, other members cannot see it', () => {
    const { shop } = setup(true)
    const chat = openChat(shop.sql, OWNER.uid, null, NOW)
    const say = (text: string, x: Extraction, chatId: string | null, at = NOW) => {
      const d = createDraft(shop.sql, OWNER, { transcript: text, source: 'text', now: at, extraction: x, chatId })
      if (chatId) touchChat(shop.sql, chatId, text, at)
      return d
    }
    const t1 = new Date(Date.parse(NOW) - 3 * 3600_000).toISOString() // 3 soat oldin — vaqt oynasidan tashqari
    const first = say('Ijaraga 300 dollar', X({ action: 'expense', amount: 300, currency: 'USD', category: 'Ijara' }), chat, t1)
    // Boshqa (chatsiz) xabar — chatga aralashmaydi.
    say('Salom', X({ action: 'unknown', question: 'Salom!' }), null)
    // Chat konteksti vaqt bilan cheklanmaydi: 3 soatdan keyin ham shu chatning xabari.
    const turns = historyTurns(shop.sql, OWNER.uid, NOW, chat)
    expect(turns.map((x) => x.role === 'user' ? x.text : JSON.parse(x.text).action)).toEqual(['Ijaraga 300 dollar', 'expense'])
    expect(historyTurns(shop.sql, OWNER.uid, NOW).map((x) => x.text)).not.toContain('Ijaraga 300 dollar')
    // Tuzatish faqat shu chatdagi ochiq qoralamani almashtiradi.
    const fix = say('dollar 12 500 dan', X({ action: 'expense', amount: 300, currency: 'USD', category: 'Ijara', revises: true, rate: 12_500 }), chat)
    expect(fix).toMatchObject({ replaces: first.id, amount: 3_750_000 })
    // Ro'yxat va tarix: sarlavha — birinchi xabar; tartib eskidan yangiga.
    expect(listChats(shop.sql, OWNER.uid)).toEqual([expect.objectContaining({ id: chat, title: 'Ijaraga 300 dollar', last: 'dollar 12 500 dan', count: 2 })])
    const entries = chatEntries(shop.sql, OWNER, chat, NOW)!
    expect(entries.map((e) => [e.draft.transcript, e.draft.status])).toEqual([['Ijaraga 300 dollar', 'cancelled'], ['dollar 12 500 dan', 'new']])
    // Boshqa a'zo (kassir) bu chatni ko'rmaydi, o'chira olmaydi; begona id bilan yozsa — o'ziga yangi chat ochiladi.
    expect(chatEntries(shop.sql, CASHIER, chat, NOW)).toBeNull()
    expect(listChats(shop.sql, CASHIER.uid)).toEqual([])
    expect(deleteChat(shop.sql, CASHIER.uid, chat)).toBe(false)
    expect(openChat(shop.sql, CASHIER.uid, chat, NOW)).not.toBe(chat)
    // O'chirish — qoralamalari bilan.
    expect(deleteChat(shop.sql, OWNER.uid, chat)).toBe(true)
    expect(shop.sql.get<{ c: number }>('SELECT COUNT(*) c FROM assistant_drafts WHERE chat_id = ?', chat)!.c).toBe(0)
  })

  it('unknown messages stay drafts with nothing to apply', () => {
    const { shop } = setup()
    const d = createDraft(shop.sql, OWNER, { transcript: 'salom', source: 'text', now: NOW, extraction: X({ action: 'unknown', question: 'Nima qilay?' }) })
    expect(d).toMatchObject({ kind: 'unknown', ready: false })
    expect(walkInId(shop)).toBeGreaterThan(0)
  })
})

describe('report questions: numbers come from the database, never from the model', () => {
  const ask = (shop: Shop, actor: typeof OWNER, p: Partial<Extraction>, transcript = 'savol') =>
    createDraft(shop.sql, actor, { transcript, source: 'text', now: NOW, extraction: X({ action: 'unknown', ...p }), lang: 'uz' })
  // Bahrom: 2 ta 25W qarzga (160 000, foyda 60 000) + naqd 1 ta 25W (80 000); Ali qarz 50 000; Vali haqdor 20 000.
  function sold() {
    const s = setup(true)
    openShiftSql(s.shop, OWNER.uid)
    for (const [cust, method, qty] of [['Bahrom', 'debt', 2], [null, 'cash', 1]] as const) {
      const d = createDraft(s.shop.sql, OWNER, { transcript: 'samsung 25W zaryadka', source: 'text', now: NOW,
        extraction: X({ action: 'sale', customer: cust, items: [{ product: 'Samsung 25W zaryadka', qty, price: null, cost: null, unit: null }], method }) })
      const r = applyDraft(s.shop.sql, OWNER, d.id, null, NOW, runAs(s.shop, OWNER))
      expect(r.ok ? 'ok' : JSON.stringify(r.error) + JSON.stringify(d.issues)).toBe('ok')
    }
    const ali = s.shop.ok<number>('saveCustomer', ['Ali', null])
    const vali = s.shop.ok<number>('saveCustomer', ['Vali', null])
    s.shop.sql.run('UPDATE customers SET balance = -50000 WHERE id = ?', ali)
    s.shop.sql.run('UPDATE customers SET balance = 20000 WHERE id = ?', vali)
    return s
  }

  it('sanitize: a "report" action becomes a text reply with a known topic only', () => {
    expect(sanitize({ action: 'report', report: 'debts', period: 'month' })).toMatchObject({ action: 'unknown', report: 'debts', period: 'month' })
    expect(sanitize({ action: 'report', report: 'weather' })).toMatchObject({ action: 'unknown', report: null, period: null })
    expect(sanitize({ action: 'sale', report: 'debts' })).toMatchObject({ action: 'sale', report: null })
  })

  it('total debts with the biggest debtors and what the shop owes; nothing is written', () => {
    const { shop } = sold()
    const before = shop.sql.get<{ c: number }>('SELECT COUNT(*) c FROM sales')!.c
    const d = ask(shop, OWNER, { report: 'debts', question: 'Sizda 999 mln qarz bor' })
    expect(d).toMatchObject({ kind: 'unknown', ready: false, report: { topic: 'debts' } })
    expect(d.question).toContain("jami 210 000 so'm qarz — 2 kishi")
    expect(d.question!.indexOf("Bahrom do'kon — 160 000")).toBeLessThan(d.question!.indexOf('Ali — 50 000'))
    expect(d.question).toContain("1 mijozga jami 20 000 so'm qarzsiz")
    expect(d.question).not.toContain('999') // modelning raqami ishlatilmaydi
    expect(shop.sql.get<{ c: number }>('SELECT COUNT(*) c FROM sales')!.c).toBe(before)
  })

  it('one customer: balance and last purchase, in the language of the question', () => {
    const { shop } = sold()
    expect(ask(shop, OWNER, { report: 'customer', customer: 'Бахром' }).question).toMatch(/^Bahrom do'kon sizga 160 000 so'm qarz\.\nOxirgi xarid: \d{4}-\d\d-\d\d — 160 000 so'm\.$/)
    expect(ask(shop, OWNER, { report: 'customer', customer: 'Bahrom', language: 'ru' }).question).toContain("Bahrom do'kon должен вам 160 000 so'm")
    expect(ask(shop, OWNER, { report: 'customer', customer: 'Vali' }).question).toContain("Siz Valiga 20 000 so'm qarzsiz")
    expect(ask(shop, OWNER, { report: 'customer', customer: 'Zuhra' }).question).toBe("«Zuhra» degan mijoz topilmadi.")
    // Mavzu nomi qoralamaga mijoz sifatida yopishmaydi.
    expect(ask(shop, OWNER, { report: 'customer', customer: 'Bahrom' })).toMatchObject({ customerId: null, items: [] })
  })

  it('sales today with the payment split and profit; cashier sees only own sales and no debts', () => {
    const { shop } = sold()
    const q = ask(shop, OWNER, { report: 'sales', period: 'today' }).question!
    expect(q).toContain("Bugun savdo: 240 000 so'm — 2 ta chek.")
    expect(q).toContain("Naqd 80 000 so'm · karta 0 so'm · qarzga 160 000 so'm.")
    expect(q).toContain("Foyda: 90 000 so'm.")
    expect(ask(shop, OWNER, { report: 'sales', period: 'yesterday' }).question).toBe("Kecha savdo bo'lmagan.")
    expect(ask(shop, CASHIER, { report: 'sales' }).question).toBe("Bugun savdo bo'lmagan.")
    expect(ask(shop, CASHIER, { report: 'debts' }).question).toBe("Bu ma'lumotni faqat do'kon egasi ko'radi.")
    expect(ask(shop, CASHIER, { report: 'stock' }).question).toBe("Bu ma'lumotni faqat do'kon egasi ko'radi.")
  })

  it('cash in the open shift (shift formula) and stock for one product or the whole store', () => {
    const { shop } = sold()
    expect(ask(shop, OWNER, { report: 'cash' }).question).toContain("Sizda: kassada 80 000 so'm bo'lishi kerak")
    expect(ask(shop, CASHIER, { report: 'cash' }).question).toBe("Hozir ochiq smena yo'q.")
    expect(ask(shop, CASHIER, { report: 'stock', items: [{ product: 'airpods', qty: null, price: null, cost: null, unit: null }] }).question)
      .toBe("AirPods Pro: 2 dona qoldi · narxi 550 000 so'm.")
    // Model katalogdagi aniq variantni (25W) o'zi qo'ysa-yu, foydalanuvchi aytmagan bo'lsa — variantlar.
    const pick = ask(shop, OWNER, { report: 'stock', items: [{ product: 'Samsung 25W zaryadka', qty: null, price: null, cost: null, unit: null }] }, 'samsung zaryadka qancha qoldi').question!
    expect(pick).toMatch(/^«samsung zaryadka» — qaysi biri\?\n• Samsung (25|45)W zaryadka/)
    expect(pick).toContain('Samsung 45W zaryadka: 3 dona qoldi')
    expect(ask(shop, OWNER, { report: 'stock', items: [{ product: 'Samsung 25W zaryadka', qty: null, price: null, cost: null, unit: null }] }, 'samsung 25W qancha qoldi').question)
      .toBe("Samsung 25W zaryadka: 7 dona qoldi · narxi 80 000 so'm.")
    const all = ask(shop, OWNER, { report: 'stock' }).question!
    expect(all).toContain('Omborda 3 xil tovar bor.')
    expect(all).toContain("tannarxda 1 450 000 so'm") // 7×50 000 + 3×100 000 + 2×400 000
    expect(all).toContain('• AirPods Pro — 2 dona')
  })

  it('report answers stay in the chat context for the model', () => {
    const { shop } = sold()
    ask(shop, OWNER, { report: 'debts' }, 'umumiy qarz qancha?')
    const turns = historyTurns(shop.sql, OWNER.uid, NOW)
    expect(JSON.parse(turns.at(-1)!.text)).toMatchObject({ action: 'unknown', report: 'debts' })
  })

  it('periods are UTC days like the Reports page', () => {
    expect(periodRange('today', '2026-11-09T01:00:00Z')).toEqual(['2026-11-09', '2026-11-09'])
    expect(periodRange('week', '2026-11-09T01:00:00Z')).toEqual(['2026-11-03', '2026-11-09'])
    expect(periodRange('last_month', '2026-01-15T00:00:00Z')).toEqual(['2025-12-01', '2025-12-31'])
  })
})

describe('reply language and greetings (prompt)', () => {
  const h = { shopName: 'Test', currency: "so'm", products: [], customers: [] }
  it('ambiguous one-word messages fall back to the app language; no second greeting the same day', () => {
    expect(systemPrompt({ ...h, lang: 'uz' })).toContain('if there are none — Uzbek (Latin script)')
    expect(systemPrompt({ ...h, lang: 'ru' })).toContain('if there are none — Russian')
    expect(systemPrompt({ ...h, lang: 'uz' })).toContain('"sava"')
    expect(systemPrompt({ ...h, greeted: true })).toContain('do NOT greet again')
    expect(systemPrompt({ ...h, greeted: false })).not.toContain('do NOT greet again')
  })
})

describe('several actions in one message; lending money to a customer', () => {
  // Haqiqiy holat (2026-11-12): «Anvarga 500 ming, Botirga 300 ming qarz berdim. Jamshiddan 200 ming qarz oldim.
  // Kamol 400 ming qarzini berdi» — model rad etib, birma-bir yozishni so'ragan edi.
  const MSG = 'anvarga 500 ming\nbotirga 300 ming qarz berdim\n\nJamshiddan 200 ming qarz oldin\nKamol 400 ming qarzini berdi'

  it('sanitize: extra actions go to also (in order); nested, unknown and corrections do not', () => {
    const x = sanitize({
      action: 'payment_out', customer: 'Anvar', amount: 500_000, method: 'cash', language: 'uz', revises: false,
      also: [
        { action: 'payment_out', customer: 'Botir', amount: '300 000', language: null, also: [{ action: 'sale' }], revises: true },
        { action: 'unknown', question: 'nima?' },
        { action: 'payment_in', customer: 'Jamshid', amount: 200_000, method: 'cash' },
        { action: 'report', report: 'debts' },
      ],
    })
    expect(x).toMatchObject({ action: 'payment_out', customer: 'Anvar', amount: 500_000 })
    expect(x.also!.map((a) => [a.action, a.customer, a.amount, a.report])).toEqual([
      ['payment_out', 'Botir', 300_000, null], ['payment_in', 'Jamshid', 200_000, null], ['unknown', null, null, 'debts'],
    ])
    // Ichma-ich `also` yo'q, ichki element tuzatish bo'la olmaydi, til asosiydan.
    expect(x.also![0]).toMatchObject({ revises: false, language: 'uz' })
    expect(x.also![0].also).toBeUndefined()
    // Tuzatish bo'lsa — qo'shimcha amallar e'tiborsiz (eski ochiq karta bilan aralashmasin).
    expect(sanitize({ action: 'expense', amount: 1, revises: true, also: [{ action: 'expense', amount: 2 }] }).also).toEqual([])
    // Chegara: asosiy + 7 ta.
    expect(sanitize({ action: 'expense', amount: 1, also: Array.from({ length: 20 }, () => ({ action: 'expense', amount: 5 })) }).also).toHaveLength(7)
    // Prompt: rad etmaslik va qarz berish/olish qoidasi.
    const prompt = systemPrompt({ shopName: 'T', currency: "so'm", products: [], customers: [] })
    expect(prompt).toContain('Never ask the user to send them one by one')
    expect(prompt).toContain('"payment_out": the shop GAVE or LENT money')
    expect(prompt).toContain('the shop BORROWED money from that person')
  })

  it('lending: the customer owes more, a negative payment is logged, the balance invariant holds; walk-in refused', () => {
    const { shop, bahrom } = setup()
    const run = runAs(shop, OWNER)
    const d = createDraft(shop.sql, OWNER, { transcript: 'Bahromga 500 ming qarz berdim', source: 'text', now: NOW, extraction: X({ action: 'payment_out', customer: 'Bahrom', amount: 500_000, method: 'cash' }) })
    expect(d).toMatchObject({ kind: 'payment_out', customerId: bahrom, method: 'cash', total: 500_000, ready: true })
    expect(applyDraft(shop.sql, OWNER, d.id, null, NOW, run).ok).toBe(true)
    expect(applyDraft(shop.sql, OWNER, d.id, null, NOW, run).ok).toBe(true) // takror — bitta yozuv
    expect(shop.sql.all('SELECT amount, method FROM customer_payments WHERE customer_id = ?', bahrom)).toEqual([{ amount: -500_000, method: 'cash' }])
    expect(shop.ok('getCustomer', [bahrom])).toMatchObject({ balance: -500_000 })
    // Keyin u 200 ming qaytardi → qarzi 300 ming; harakatlar = saldo − dastlabki (invariant).
    shop.ok('recordCustomerPayment', [bahrom, 200_000, 'cash'])
    expect(shop.ok('getCustomer', [bahrom])).toMatchObject({ balance: -300_000, opening_balance: 0 })
    expect(shop.ok('customerMovements', [bahrom])).toBe(-300_000)
    // Yo'l-yo'lakay xaridorga qarz berilmaydi (qoralama ham, op ham).
    const wi = shop.call('recordCustomerPayout', [walkInId(shop), 1000, 'cash'])
    expect(wi.ok ? null : wi.error.code).toBe('sales.noDebtForWalkIn')
    const nobody = createDraft(shop.sql, OWNER, { transcript: '500 ming qarz berdim', source: 'text', now: NOW, extraction: X({ action: 'payment_out', amount: 500_000 }) })
    expect(nobody.issues.map((i) => i.code)).toEqual(['customerNeededOut'])
    // Kassir qarz bera olmaydi; bazada yo'q odam — tasdiqlashda yaratiladi (to'lovdagi kabi).
    expect(createDraft(shop.sql, CASHIER, { transcript: 'x', source: 'text', now: NOW, extraction: X({ action: 'payment_out', customer: 'Bahrom', amount: 1 }) }).issues.map((i) => i.code)).toContain('notAllowed')
    const fresh = createDraft(shop.sql, OWNER, { transcript: 'Anvarga 500 ming qarz berdim', source: 'text', now: NOW, extraction: X({ action: 'payment_out', customer: 'Anvar', amount: 500_000 }) })
    expect(fresh).toMatchObject({ newCustomer: 'Anvar', ready: true })
    expect(applyDraft(shop.sql, OWNER, fresh.id, null, NOW, run).ok).toBe(true)
    expect(shop.sql.get<{ balance: number }>("SELECT balance FROM customers WHERE name = 'Anvar'")!.balance).toBe(-500_000)
  })

  it('lent money is not counted as a received payment in report answers', () => {
    const { shop, bahrom } = setup()
    shop.ok('recordCustomerPayment', [bahrom, 70_000, 'cash'])
    shop.ok('recordCustomerPayout', [bahrom, 500_000, 'cash'])
    const ask = (report: Extraction['report'], customer: string | null = null) =>
      createDraft(shop.sql, OWNER, { transcript: '?', source: 'text', now: NOW, extraction: X({ action: 'unknown', report, customer }) }).question!
    const cash = ask('cash')
    expect(cash).toContain("Bugun mijozlardan naqd to'lov: 70 000 so'm.")
    expect(cash).toContain("Bugun mijozlarga naqd qarz berildi: 500 000 so'm.")
    expect(ask('customer', 'Bahrom')).toContain('70 000')
    expect(ask('customer', 'Bahrom')).not.toContain('−500')
  })

  it('one message → one draft per action (partOf the first); history shows the message once', () => {
    const { shop } = setup()
    shop.ok('saveCustomer', ['Kamol', null])
    const chat = openChat(shop.sql, OWNER.uid, null, NOW)
    const x = sanitize({
      action: 'payment_out', customer: 'Anvar', amount: 500_000, method: 'cash', language: 'uz',
      also: [
        { action: 'payment_out', customer: 'Botir', amount: 300_000, method: 'cash' },
        { action: 'payment_in', customer: 'Jamshid', amount: 200_000, method: 'cash' },
        { action: 'payment_in', customer: 'Kamol', amount: 400_000, method: 'cash' },
      ],
    })
    // ShopDO.assistantDraft bilan bir xil: birinchisi, keyin qolganlari partOf bilan (bitta vaqt belgisi).
    const first = createDraft(shop.sql, OWNER, { transcript: MSG, source: 'bot_text', now: NOW, extraction: x, chatId: chat })
    const rest = x.also!.map((e) => createDraft(shop.sql, OWNER, { transcript: MSG, source: 'bot_text', now: NOW, extraction: { ...e, revises: true }, chatId: chat, partOf: first.id }))
    expect([first, ...rest].map((d) => [d.kind, d.customerName ?? d.newCustomer, d.amount, d.ready])).toEqual([
      ['payment_out', 'Anvar', 500_000, true], ['payment_out', 'Botir', 300_000, true],
      ['payment_in', 'Jamshid', 200_000, true], ['payment_in', 'Kamol', 400_000, true],
    ])
    // Keyingi amal hech qachon tuzatish emas — birinchisini bekor qilmaydi.
    expect(rest.every((d) => d.partOf === first.id && !d.replaces)).toBe(true)
    expect(loadDraft(shop.sql, OWNER, first.id, NOW)!.status).toBe('new')
    // Chat tarixi tartibda; model kontekstida xabar bir marta, to'rtta xulosa bitta javobda.
    expect(chatEntries(shop.sql, OWNER, chat, NOW)!.map((e) => e.draft.id)).toEqual([first.id, ...rest.map((d) => d.id)])
    const turns = historyTurns(shop.sql, OWNER.uid, NOW, chat)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(turns[1].text.split('\n').map((l) => JSON.parse(l).customer)).toEqual(['Anvar', 'Botir', 'Jamshid', 'Kamol'])
    // Hammasi tasdiqlanadi — har biri o'z yozuvi.
    const run = runAs(shop, OWNER)
    for (const d of [first, ...rest]) expect(applyDraft(shop.sql, OWNER, d.id, null, NOW, run).ok).toBe(true)
    const bal = (n: string) => shop.sql.get<{ balance: number }>('SELECT balance FROM customers WHERE name = ?', n)!.balance
    expect([bal('Anvar'), bal('Botir'), bal('Jamshid'), bal('Kamol')]).toEqual([-500_000, -300_000, 200_000, 400_000])
  })
})
