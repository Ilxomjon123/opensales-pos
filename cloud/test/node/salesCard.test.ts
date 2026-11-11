import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { salesCaption, salesCardData, salesCardHtml } from '../../src/telegram/salesCard'
import type { CardStats } from '../../src/shop/cardStats'

// Egaga "Savdo" kartasi — Telegram widget chegaralari (sendWidget): html ≤32768 bayt va zlib(9) ≤4096; chat_data ≤1024.
const stats = (over: Partial<CardStats> = {}): CardStats => ({
  shop: 'Choyxona', currency: "so'm", total: 1250000, count: 12, profit: 180000.456, cash: 900000, card: 300000, debt: 50000,
  returns: 0, expenses: 20000, receivable: 2300000, debtors: 7, week: [0, 1, 2, 3, 4, 5, 1250000], top: [{ name: 'Coca-Cola 1L', total: 120000 }],
  ...over,
})

describe('sales widget card', () => {
  for (const lang of ['uz', 'ru'] as const) {
    it(`${lang}: html fits the limits, is valid JS and loads nothing from the network`, () => {
      const html = salesCardHtml(lang)
      const bytes = Buffer.from(html, 'utf8')
      expect(bytes.length).toBeLessThanOrEqual(32768)
      expect(deflateSync(bytes, { level: 9 }).length).toBeLessThanOrEqual(4096)
      expect(html).not.toMatch(/\bsrc=|https?:\/\/|@import|@font-face|fetch\(|__T__/)
      const code = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? ''
      // eslint-disable-next-line no-new-func
      expect(() => new Function(code)).not.toThrow()
      // Foydalanuvchi matni (tovar/do'kon nomi) faqat textContent bilan — innerHTML faqat tozalash uchun.
      expect(code.match(/innerHTML=(?!"")/g)).toBeNull()
      // Raqam formati regex'i String.raw bilan saqlangan (template literal `\d` ni yo'qotmasin).
      expect(code).toContain('\\B(?=(\\d{3})+(?!\\d))')
    })
  }

  it('chat_data stays within 1024 bytes with long Cyrillic names', () => {
    const long = 'Очень длинное название товара номер '
    const raw = salesCardData('a'.repeat(32), 'm', stats({
      shop: 'Супермаркет «Самый лучший магазин на районе»', currency: 'сўм', top: [1, 2, 3].map((i) => ({ name: long + i, total: 99999999.999 })),
    }), new Date(0))
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(1024)
    const d = JSON.parse(raw)
    expect(d).toMatchObject({ r: 0, s: 'a'.repeat(32), p: 'm' })
    expect(d.n.length).toBeLessThanOrEqual(28)
    expect(d.t[0][0].length).toBeLessThanOrEqual(26)
    expect(d.t[0][1]).toBe(100000000)
  })

  it('money is rounded to cents; order of v is fixed', () => {
    const d = JSON.parse(salesCardData('b'.repeat(32), 't', stats(), new Date(5)))
    expect(d.v).toEqual([1250000, 12, 180000.46, 900000, 300000, 50000, 0, 20000, 2300000, 7])
    expect(d.w).toEqual([0, 1, 2, 3, 4, 5, 1250000])
    expect(d.t).toEqual([['Coca-Cola 1L', 120000]])
  })

  it('caption is the text fallback (uz/ru)', () => {
    expect(salesCaption(stats(), 't', 'uz')).toBe("🧾 Choyxona · Bugun: savdo 1 250 000 so'm, 12 ta chek, foyda 180 000,46 so'm.")
    expect(salesCaption(stats(), 'w', 'ru')).toBe("🧾 Choyxona · 7 дней: продажи 1 250 000 so'm, чеков: 12, прибыль 180 000,46 so'm.")
  })
})
