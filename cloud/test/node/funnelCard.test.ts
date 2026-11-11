import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { FUNNEL_WIDGET_HTML, funnelCaption, funnelWidgetData } from '../../src/telegram/funnelCard'

// Telegram HTML widget chegaralari (Bot API 10.4 sendWidget): html 1-32768 bayt va zlib (eng yuqori daraja)
// bilan ≤4096 bayt; chat_data ≤1024 bayt. Oshsa Telegram kartani qabul qilmaydi — admin hech narsa ko'rmaydi.
describe('funnel widget card', () => {
  it('html fits the sendWidget limits and loads nothing from the network', () => {
    const bytes = Buffer.from(FUNNEL_WIDGET_HTML, 'utf8')
    expect(bytes.length).toBeLessThanOrEqual(32768)
    expect(deflateSync(bytes, { level: 9 }).length).toBeLessThanOrEqual(4096)
    // Widget sandbox'ida tarmoq yo'q: tashqi skript/rasm/shrift jim tashlab yuboriladi.
    expect(FUNNEL_WIDGET_HTML).not.toMatch(/\bsrc=|https?:\/\/|@import|@font-face|fetch\(/)
  })

  it('the widget script is valid JavaScript', () => {
    const code = /<script>([\s\S]*)<\/script>/.exec(FUNNEL_WIDGET_HTML)?.[1] ?? ''
    expect(code.length).toBeGreaterThan(100)
    // eslint-disable-next-line no-new-func
    expect(() => new Function(code)).not.toThrow()
  })

  it('user names are drawn as text, never parsed as HTML', () => {
    const code = /<script>([\s\S]*)<\/script>/.exec(FUNNEL_WIDGET_HTML)?.[1] ?? ''
    // innerHTML faqat tozalash uchun ('') — foydalanuvchi matni textContent orqali.
    expect(code.match(/innerHTML=(?!'')/g)).toBeNull()
  })

  it('chat_data stays within 1024 bytes even with many long Cyrillic names', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      uid: 1000 + i, name: 'Абдурахмонов Ильхомжон Батырович ' + i, username: null, shop_name: 'Супермаркет «Самый лучший магазин» №' + i,
      products: i, sales: i * 3, pm_at: i % 2 ? '2026-11-11T00:00:00Z' : null,
    }))
    const stages = { entered: 200, started: 150, opened: 120, shop: 80, product: 30, sale: 10, day2: 3, pm: 140 }
    const raw = funnelWidgetData({ days: 7, stages, rows }, new Date('2026-11-11T10:00:00Z'))
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(1024)
    const d = JSON.parse(raw)
    expect(d).toMatchObject({ r: Date.parse('2026-11-11T10:00:00Z'), d: 7, s: [200, 150, 120, 80, 30, 10, 3, 140] })
    expect(d.p.length).toBeGreaterThan(0)
    expect(d.p.length).toBeLessThanOrEqual(5)
    expect(d.p[0][0].length).toBeLessThanOrEqual(18)
    expect(d.p[0].slice(2)).toEqual([0, 0, 0])
  })

  it('falls back to @username / uid for nameless people; empty funnel still renders', () => {
    const raw = funnelWidgetData({ days: 0, stages: {}, rows: [
      { uid: 5, name: null, username: 'ali', shop_name: null, products: 0, sales: 0, pm_at: null },
      { uid: 6, name: '', username: null, shop_name: 'Dokon', products: 2, sales: 1, pm_at: 'x' },
    ] }, new Date(0))
    expect(JSON.parse(raw)).toEqual({ r: 0, d: 0, s: [0, 0, 0, 0, 0, 0, 0, 0], p: [['@ali', '', 0, 0, 0], ['6', 'Dokon', 2, 1, 1]] })
  })

  it('caption is the text fallback for apps without widget support', () => {
    expect(funnelCaption({ entered: 12, shop: 8, product: 2, sale: 0 }, 7)).toMatch(/^📊 Varonka · 7 kun: 12 kirdi → 8 do'kon → 2 tovar → 0 sotuv\./)
    expect(funnelCaption({}, 0)).toContain('hammasi')
  })
})
