import type { Sql } from './sql'
import type { Actor } from './rpc'
import { rank, words } from '../assistant/match'

// Yordamchi — hisobot savollari ("umumiy qarz qancha?", "bugun qancha sotdik?", "kassada qancha bor?").
//
// AI faqat SAVOL TURINI aniqlaydi (mavzu, davr, mijoz/tovar nomi) — raqamlarni bu yerda bazadan
// deterministik hisoblaymiz va tayyor matn qaytaramiz. Model raqam to'qiy olmaydi.
// Kunlar — UTC sana bo'yicha (Hisobot sahifasi bilan bir xil: `date(created_at)`), raqamlar u bilan mos.

export const REPORT_TOPICS = ['debts', 'customer', 'sales', 'cash', 'stock', 'expenses', 'top_products'] as const
export const REPORT_PERIODS = ['today', 'yesterday', 'week', 'month', 'last_month', 'year', 'all'] as const
export type ReportTopic = (typeof REPORT_TOPICS)[number]
export type ReportPeriod = (typeof REPORT_PERIODS)[number]
/** said — foydalanuvchining o'z so'zlari: model qo'shgan model raqami (#121, 25W) aytilmagan bo'lsa — aniq tanlov emas. */
export type ReportQuery = { topic: ReportTopic; period: ReportPeriod | null; subject: string | null; said?: string }
export type AnswerLang = 'uz' | 'ru'

/** Kassir ham so'rashi mumkin bo'lganlar (qolgani — faqat ega; Hisobot sahifasi ham faqat egaga). */
const CASHIER_TOPICS: ReportTopic[] = ['stock', 'sales', 'cash']
const TOP_N = 5

const T = {
  uz: {
    notAllowed: "Bu ma'lumotni faqat do'kon egasi ko'radi.",
    period: { today: 'Bugun', yesterday: 'Kecha', week: 'Oxirgi 7 kunda', month: 'Shu oy', last_month: "O'tgan oy", year: 'Shu yil', all: 'Hammasi bo\'lib' },
    debtsTotal: 'Mijozlar sizga jami {sum} qarz — {n} kishi.',
    debtsTop: "Eng ko'p qarzdorlar:",
    debtsNone: "Hozir hech kim sizga qarz emas.",
    creditTotal: "Siz {n} mijozga jami {sum} qarzsiz (oldindan to'lov).",
    more: '… yana {n} kishi',
    custNotFound: '«{q}» degan mijoz topilmadi.',
    custPick: '«{q}» — qaysi biri? {opts}',
    custNeeded: "Qaysi mijoz? Ismini ayting, masalan: «Ali akaning qarzi qancha?»",
    custDebt: '{name} sizga {sum} qarz.',
    custCredit: "Siz {name}ga {sum} qarzsiz (oldindan to'lov).",
    custZero: "{name} bilan hisob teng — qarz yo'q.",
    custLastSale: 'Oxirgi xarid: {date} — {sum}.',
    custLastPay: "Oxirgi to'lov: {date} — {sum}.",
    salesNone: '{p} savdo bo\'lmagan.',
    salesHead: '{p} savdo: {sum} — {n} ta chek.',
    salesOwn: '{p} sizning savdoyingiz: {sum} — {n} ta chek.',
    salesSplit: 'Naqd {cash} · karta {card} · qarzga {debt}.',
    salesReturns: 'Qaytarildi: {sum}.',
    salesProfit: 'Foyda: {sum}.',
    cashNoShift: "Hozir ochiq smena yo'q.",
    cashShift: '{who}: kassada {sum} bo\'lishi kerak (ochilishda {open}, naqd savdo {cash}{ref}).',
    cashRef: ', qaytarilgan {sum}',
    you: 'Sizda',
    cashPays: "Bugun mijozlardan naqd to'lov: {sum}.",
    cashExp: 'Bugungi xarajat: {sum}.',
    stockOne: '{name}: {qty} {unit} qoldi · narxi {price}.',
    stockOut: '{name}: qolmagan (0 {unit}) · narxi {price}.',
    stockPick: '«{q}» — qaysi biri?',
    stockNotFound: '«{q}» degan tovar topilmadi.',
    stockSummary: 'Omborda {n} xil tovar bor.',
    stockValue: 'Qoldiq qiymati: tannarxda {cost}, sotuv narxida {retail}.',
    stockOutCount: 'Tugagan: {n} xil tovar.',
    stockLow: 'Kam qolganlar:',
    expNone: '{p} xarajat bo\'lmagan.',
    expHead: '{p} xarajat: {sum}.',
    topNone: '{p} sotuv bo\'lmagan.',
    topHead: "{p} eng ko'p sotilganlar:",
  },
  ru: {
    notAllowed: 'Эти данные видит только владелец магазина.',
    period: { today: 'Сегодня', yesterday: 'Вчера', week: 'За 7 дней', month: 'В этом месяце', last_month: 'В прошлом месяце', year: 'В этом году', all: 'За всё время' },
    debtsTotal: 'Клиенты должны вам всего {sum} — {n} чел.',
    debtsTop: 'Больше всего должны:',
    debtsNone: 'Сейчас никто вам не должен.',
    creditTotal: 'Вы должны {n} клиентам всего {sum} (предоплата).',
    more: '… и ещё {n}',
    custNotFound: 'Клиент «{q}» не найден.',
    custPick: '«{q}» — кто именно? {opts}',
    custNeeded: 'Какой клиент? Назовите имя, например: «Сколько должен Али?»',
    custDebt: '{name} должен вам {sum}.',
    custCredit: 'Вы должны {name} {sum} (предоплата).',
    custZero: '{name}: долга нет, расчёт закрыт.',
    custLastSale: 'Последняя покупка: {date} — {sum}.',
    custLastPay: 'Последняя оплата: {date} — {sum}.',
    salesNone: '{p} продаж не было.',
    salesHead: '{p} продажи: {sum} — {n} чек(ов).',
    salesOwn: '{p} ваши продажи: {sum} — {n} чек(ов).',
    salesSplit: 'Наличные {cash} · карта {card} · в долг {debt}.',
    salesReturns: 'Возвраты: {sum}.',
    salesProfit: 'Прибыль: {sum}.',
    cashNoShift: 'Сейчас нет открытой смены.',
    cashShift: '{who}: в кассе должно быть {sum} (на открытии {open}, наличные продажи {cash}{ref}).',
    cashRef: ', возвраты {sum}',
    you: 'У вас',
    cashPays: 'Сегодня оплаты наличными от клиентов: {sum}.',
    cashExp: 'Расходы за сегодня: {sum}.',
    stockOne: '{name}: осталось {qty} {unit} · цена {price}.',
    stockOut: '{name}: нет в наличии (0 {unit}) · цена {price}.',
    stockPick: '«{q}» — какой именно?',
    stockNotFound: 'Товар «{q}» не найден.',
    stockSummary: 'На складе {n} наименований.',
    stockValue: 'Стоимость остатка: по себестоимости {cost}, по цене продажи {retail}.',
    stockOutCount: 'Закончилось: {n} наименований.',
    stockLow: 'Заканчиваются:',
    expNone: '{p} расходов не было.',
    expHead: '{p} расходы: {sum}.',
    topNone: '{p} продаж не было.',
    topHead: '{p} больше всего продано:',
  },
} as const

const fill = (s: string, p: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? ''))

const num = (n: number) => {
  const r = Math.round(n * 100) / 100
  const [i, f] = String(Math.abs(r)).split('.')
  return (r < 0 ? '−' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (f ? ',' + f : '')
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Davr → [from, to] (UTC sana, ikkala chet kiradi). */
export function periodRange(p: ReportPeriod, now: string): [string, string] {
  const t = Date.parse(now)
  const today = day(t)
  const d = new Date(t)
  switch (p) {
    case 'today': return [today, today]
    case 'yesterday': { const y = day(t - 86_400_000); return [y, y] }
    case 'week': return [day(t - 6 * 86_400_000), today]
    case 'month': return [today.slice(0, 8) + '01', today]
    case 'last_month': {
      const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)
      const last = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)
      return [day(first), day(last)]
    }
    case 'year': return [today.slice(0, 4) + '-01-01', today]
    case 'all': return ['0000-01-01', today]
  }
}

/** Savolga tayyor javob matni (oddiy matn, qatorlar bilan). */
export function answerReport(sql: Sql, actor: Actor, q: ReportQuery, lang: AnswerLang, now: string): string {
  const t = T[lang]
  if (actor.role !== 'owner' && !CASHIER_TOPICS.includes(q.topic)) return t.notAllowed
  const cur = sql.get<{ value: string | null }>("SELECT value FROM settings WHERE key = 'currency_symbol'")?.value || "so'm"
  const money = (n: number) => `${num(n)} ${cur}`
  const period: ReportPeriod = q.period ?? 'today'
  const pl = t.period[period]
  const [from, to] = periodRange(period, now)
  const lines: string[] = []

  switch (q.topic) {
    case 'debts': {
      const d = sql.get<{ n: number; s: number }>('SELECT COUNT(*) n, COALESCE(SUM(-balance),0) s FROM customers WHERE is_active = 1 AND is_walk_in = 0 AND balance < 0')!
      const c = sql.get<{ n: number; s: number }>('SELECT COUNT(*) n, COALESCE(SUM(balance),0) s FROM customers WHERE is_active = 1 AND is_walk_in = 0 AND balance > 0')!
      if (!d.n) lines.push(t.debtsNone)
      else {
        lines.push(fill(t.debtsTotal, { sum: money(d.s), n: d.n }))
        const top = sql.all<{ name: string; b: number }>(
          'SELECT name, -balance b FROM customers WHERE is_active = 1 AND is_walk_in = 0 AND balance < 0 ORDER BY balance ASC, id LIMIT ?', TOP_N,
        )
        lines.push('', t.debtsTop, ...top.map((r) => `• ${r.name} — ${money(r.b)}`))
        if (d.n > top.length) lines.push(fill(t.more, { n: d.n - top.length }))
      }
      if (c.n) lines.push('', fill(t.creditTotal, { sum: money(c.s), n: c.n }))
      break
    }
    case 'customer': {
      if (!q.subject) { lines.push(t.custNeeded); break }
      const list = sql.all<{ id: number; name: string; phone: string | null; balance: number }>(
        'SELECT id, name, phone, balance FROM customers WHERE is_active = 1 AND is_walk_in = 0',
      )
      const { top, confident } = rank(q.subject, list, (c) => c.name, { extra: (c) => c.phone })
      if (!top.length) { lines.push(fill(t.custNotFound, { q: q.subject })); break }
      if (!confident) {
        lines.push(fill(t.custPick, { q: q.subject, opts: '' }).trim())
        for (const c of top.slice(0, TOP_N)) lines.push(`• ${c.item.name} — ${balanceWord(c.item.balance, money, lang)}`)
        break
      }
      const c = top[0].item
      lines.push(fill(c.balance < 0 ? t.custDebt : c.balance > 0 ? t.custCredit : t.custZero, { name: c.name, sum: money(Math.abs(c.balance)) }))
      const sale = sql.get<{ at: string; total: number }>('SELECT created_at at, total FROM sales WHERE customer_id = ? ORDER BY id DESC LIMIT 1', c.id)
      const pay = sql.get<{ at: string; amount: number }>('SELECT created_at at, amount FROM customer_payments WHERE customer_id = ? ORDER BY id DESC LIMIT 1', c.id)
      if (sale) lines.push(fill(t.custLastSale, { date: sale.at.slice(0, 10), sum: money(sale.total) }))
      if (pay) lines.push(fill(t.custLastPay, { date: pay.at.slice(0, 10), sum: money(pay.amount) }))
      break
    }
    case 'sales': {
      // Kassir — faqat o'z savdosi (Sotuvlar sahifasidagi kabi), foydasiz.
      const own = actor.role !== 'owner'
      const s = sql.get<{ n: number; total: number; cash: number; card: number; debt: number }>(
        `SELECT COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(paid_cash),0) cash, COALESCE(SUM(paid_card),0) card,
                COALESCE(SUM(debt_amount),0) debt
         FROM sales WHERE date(created_at) BETWEEN ? AND ? AND (? = 0 OR user_id = ?)`, from, to, own ? 1 : 0, actor.uid,
      )!
      const r = sql.get<{ amount: number; cash: number; card: number }>(
        `SELECT COALESCE(SUM(amount),0) amount, COALESCE(SUM(refund_cash),0) cash, COALESCE(SUM(refund_card),0) card
         FROM sale_returns WHERE date(created_at) BETWEEN ? AND ? AND (? = 0 OR user_id = ?)`, from, to, own ? 1 : 0, actor.uid,
      )!
      if (!s.n && !r.amount) { lines.push(fill(t.salesNone, { p: pl })); break }
      lines.push(fill(own ? t.salesOwn : t.salesHead, { p: pl, sum: money(s.total - r.amount), n: s.n }))
      lines.push(fill(t.salesSplit, { cash: money(s.cash - r.cash), card: money(s.card - r.card), debt: money(s.debt) }))
      if (r.amount) lines.push(fill(t.salesReturns, { sum: money(r.amount) }))
      if (!own) {
        // Foyda — Hisobot sahifasidagi formula (reports.ts: reportSummary).
        const p = sql.get<{ v: number }>(
          `SELECT COALESCE(SUM((si.price - COALESCE(NULLIF(si.cost_price,0), pr.cost_price, 0)) * si.qty),0) v
           FROM sale_items si LEFT JOIN products pr ON pr.id = si.product_id JOIN sales s ON s.id = si.sale_id
           WHERE date(s.created_at) BETWEEN ? AND ?`, from, to,
        )?.v ?? 0
        const rp = sql.get<{ v: number }>(
          `SELECT COALESCE(SUM((ri.price - COALESCE(NULLIF(ri.cost_price,0), pr.cost_price, 0)) * ri.qty),0) v
           FROM sale_return_items ri LEFT JOIN products pr ON pr.id = ri.product_id JOIN sale_returns r ON r.id = ri.return_id
           WHERE date(r.created_at) BETWEEN ? AND ?`, from, to,
        )?.v ?? 0
        lines.push(fill(t.salesProfit, { sum: money(Math.round(p - rp)) }))
      }
      break
    }
    case 'cash': {
      // Smena "kassada bo'lishi kerak" — Smenalar sahifasi formulasi (shifts.ts: shiftStats).
      const own = actor.role !== 'owner'
      const shifts = sql.all<{ id: number; open: number; uid: number | null; name: string | null }>(
        `SELECT s.id, s.opening_cash open, s.user_id uid, m.name FROM shifts s LEFT JOIN members m ON m.uid = s.user_id
         WHERE s.status = 'open' AND (? = 0 OR s.user_id = ?) ORDER BY s.id`, own ? 1 : 0, actor.uid,
      )
      if (!shifts.length) lines.push(t.cashNoShift)
      for (const sh of shifts) {
        const cash = sql.get<{ v: number }>('SELECT COALESCE(SUM(paid_cash),0) v FROM sales WHERE shift_id = ?', sh.id)?.v ?? 0
        const ref = sql.get<{ v: number }>('SELECT COALESCE(SUM(refund_cash),0) v FROM sale_returns WHERE shift_id = ?', sh.id)?.v ?? 0
        lines.push(fill(t.cashShift, {
          who: sh.uid === actor.uid ? t.you : sh.name ?? '—', sum: money(sh.open + cash - ref), open: money(sh.open), cash: money(cash),
          ref: ref ? fill(t.cashRef, { sum: money(ref) }) : '',
        }))
      }
      if (!own) {
        const [d0] = periodRange('today', now)
        const pays = sql.get<{ v: number }>("SELECT COALESCE(SUM(amount),0) v FROM customer_payments WHERE method = 'cash' AND date(created_at) = ?", d0)?.v ?? 0
        const exp = sql.get<{ v: number }>('SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE date(created_at) = ?', d0)?.v ?? 0
        if (pays) lines.push(fill(t.cashPays, { sum: money(pays) }))
        if (exp) lines.push(fill(t.cashExp, { sum: money(exp) }))
      }
      break
    }
    case 'stock': {
      const products = sql.all<{ id: number; name: string; unit: string; price: number; stock: number; barcode: string | null }>(
        'SELECT id, name, unit, price, stock, barcode FROM products WHERE is_active = 1',
      )
      if (q.subject) {
        let shown = q.subject
        let { top, confident } = rank(q.subject, products, (p) => p.name, { extra: (p) => p.barcode })
        // Qoralamadagi kabi: nomdagi raqamli belgi foydalanuvchi so'zlarida yo'q — model o'zi tanlagan, variantlar ko'rsatiladi.
        if (confident && q.said !== undefined) {
          const said = new Set(words(q.said))
          const ungrounded = words(top[0].item.name).filter((w) => /\d/.test(w) && !said.has(w))
          if (ungrounded.length) {
            const base = words(q.subject).filter((w) => !ungrounded.includes(w)).join(' ')
            const again = rank(base || q.subject, products, (p) => p.name, { limit: 8 })
            const close = again.top.filter((c) => c.score >= again.top[0].score - 0.05)
            if (close.length > 1) { top = again.top; confident = false; shown = base || q.subject }
          }
        }
        if (!top.length) { lines.push(fill(t.stockNotFound, { q: q.subject })); break }
        const one = (p: (typeof products)[number]) => fill(p.stock > 0 ? t.stockOne : t.stockOut, { name: p.name, qty: num(p.stock), unit: p.unit, price: money(p.price) })
        if (confident) { lines.push(one(top[0].item)); break }
        lines.push(fill(t.stockPick, { q: shown }), ...top.slice(0, TOP_N).map((c) => `• ${one(c.item)}`))
        break
      }
      if (actor.role !== 'owner') { lines.push(t.notAllowed); break }
      const v = sql.get<{ n: number; cost: number; retail: number; out: number }>(
        `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN stock > 0 THEN stock * cost_price END),0) cost,
                COALESCE(SUM(CASE WHEN stock > 0 THEN stock * price END),0) retail, COALESCE(SUM(stock <= 0),0) out
         FROM products WHERE is_active = 1`,
      )!
      lines.push(fill(t.stockSummary, { n: v.n }), fill(t.stockValue, { cost: money(Math.round(v.cost)), retail: money(Math.round(v.retail)) }))
      if (v.out) lines.push(fill(t.stockOutCount, { n: v.out }))
      // "Kam qolgan" — Hisobot sahifasidagi chegara (≤ 10), tugaganlardan tashqari.
      const low = sql.all<{ name: string; stock: number; unit: string }>(
        'SELECT name, stock, unit FROM products WHERE is_active = 1 AND stock > 0 AND stock <= 10 ORDER BY stock, name LIMIT ?', TOP_N,
      )
      if (low.length) lines.push('', t.stockLow, ...low.map((p) => `• ${p.name} — ${num(p.stock)} ${p.unit}`))
      break
    }
    case 'expenses': {
      const rows = sql.all<{ category: string; s: number }>(
        'SELECT category, SUM(amount) s FROM expenses WHERE date(created_at) BETWEEN ? AND ? GROUP BY category ORDER BY s DESC', from, to,
      )
      const total = rows.reduce((a, r) => a + r.s, 0)
      if (!total) { lines.push(fill(t.expNone, { p: pl })); break }
      lines.push(fill(t.expHead, { p: pl, sum: money(total) }), ...rows.map((r) => `• ${r.category} — ${money(r.s)}`))
      break
    }
    case 'top_products': {
      const rows = sql.all<{ name: string; unit: string; qty: number; total: number }>(
        `SELECT name, MAX(unit) unit, SUM(qty) qty, SUM(total) total FROM (
           SELECT si.product_name name, si.unit unit, si.qty qty, si.subtotal total
           FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE date(s.created_at) BETWEEN ? AND ?
           UNION ALL
           SELECT ri.product_name, ri.unit, -ri.qty, -ri.subtotal
           FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id WHERE date(r.created_at) BETWEEN ? AND ?
         ) GROUP BY name HAVING SUM(qty) > 0.000001 ORDER BY total DESC LIMIT ?`, from, to, from, to, TOP_N,
      )
      if (!rows.length) { lines.push(fill(t.topNone, { p: pl })); break }
      lines.push(fill(t.topHead, { p: pl }), ...rows.map((r) => `• ${r.name} — ${num(r.qty)} ${r.unit} · ${money(r.total)}`))
      break
    }
  }
  return lines.join('\n').slice(0, 1500)
}

function balanceWord(b: number, money: (n: number) => string, lang: AnswerLang): string {
  if (lang === 'ru') return b < 0 ? `должен ${money(-b)}` : b > 0 ? `предоплата ${money(b)}` : 'без долга'
  return b < 0 ? `qarzi ${money(-b)}` : b > 0 ? `haqi ${money(b)}` : "qarz yo'q"
}
