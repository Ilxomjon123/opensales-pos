import { describe, expect, it } from 'vitest'
import { call, mockTelegram, onboard, tg, tgUser } from './helpers'

// Varonka kartasi (Telegram HTML widget, funnelWidget.ts). Admin = ADMIN_CHAT_ID (777).
mockTelegram()

const hdr = { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }
const hook = (body: Record<string, unknown>) => call('/tg/webhook', { body, headers: hdr })
const cmd = (text: string, chat = 777) => hook({ message: { message_id: 9, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'A' }, text } })
const query = (data: string, from = 777, extra: Record<string, unknown> = {}) => hook({
  widget_query: { id: 'wq1', from: { id: from, first_name: 'A' }, chat: { id: from, type: 'private' }, message_id: 4242, chat_instance: '1', type: { type: 'data' }, data, ...extra },
})

describe('funnel widget card', () => {
  it('/varonka from the admin chat sends a live widget with funnel state and a text caption', async () => {
    await onboard('Karta dokoni', tgUser('Karta'))
    tg.calls = []
    await cmd('/varonka')
    const w = tg.calls.find((c) => c.method === 'sendWidget')!
    expect(w.body).toMatchObject({ chat_id: 777, allow_queries: true })
    expect(w.body.html).toContain('TelegramWidget')
    expect(w.body.caption).toMatch(/^📊 Varonka · 7 kun: \d+ kirdi/)
    const data = JSON.parse(w.body.chat_data)
    expect(data.d).toBe(7)
    expect(data.s).toHaveLength(8)
    expect(data.s[0]).toBeGreaterThanOrEqual(1)
    expect(data.p.some((p: unknown[]) => p[1] === 'Karta dokoni')).toBe(true)
    expect(new TextEncoder().encode(w.body.chat_data).length).toBeLessThanOrEqual(1024)
    expect(w.body.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://kassa.test/admin')

    tg.calls = []
    await cmd('/varonka 30')
    expect(JSON.parse(tg.calls.find((c) => c.method === 'sendWidget')!.body.chat_data).d).toBe(30)
  })

  it('bad period and non-admin chats get no widget', async () => {
    tg.calls = []
    await cmd('/varonka 5')
    expect(tg.calls.some((c) => c.method === 'sendWidget')).toBe(false)
    expect(tg.calls.find((c) => c.method === 'sendMessage')!.body.text).toContain('Format: /varonka')

    tg.calls = []
    await cmd('/varonka', 555)
    expect(tg.calls.some((c) => c.method === 'sendWidget')).toBe(false)
  })

  it('a widget query from the admin is answered first, then the card state is replaced', async () => {
    tg.calls = []
    await query('d:30')
    expect(tg.calls.map((c) => c.method)).toEqual(['answerWidgetQuery', 'editMessageWidgetData'])
    expect(tg.calls[0].body).toEqual({ widget_query_id: 'wq1', data: 'ok' })
    expect(tg.calls[1].body).toMatchObject({ chat_id: 777, message_id: 4242 })
    expect(JSON.parse(tg.calls[1].body.chat_data)).toMatchObject({ d: 30 })
  })

  it('queries from strangers or with bad data are answered and change nothing', async () => {
    for (const [data, from, extra, answer] of [
      ['d:7', 555, {}, 'forbidden'],
      ['d:5', 777, {}, 'bad'],
      ['drop table', 777, {}, 'bad'],
      ['d:7', 777, { chat: undefined, message_id: undefined, inline_message_id: 'x' }, 'bad'],
    ] as const) {
      tg.calls = []
      await query(data, from, extra)
      expect(tg.calls).toEqual([{ method: 'answerWidgetQuery', body: { widget_query_id: 'wq1', data: answer } }])
    }
  })
})
