import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { route } from '../../src/index'
import { signInitData } from '../../src/auth/initData'
import type { AiRunner, Extraction } from '../../src/assistant/ai'

// AI yordamchisi HTTP va bot orqali — soxta Workers AI bilan (haqiqiy model chaqirilmaydi).
// Soxta Whisper: audio baytlari = transkripsiya matni (UTF-8). Soxta LLM: matn → oldindan berilgan javob.

type TgCall = { method: string; body: any }
let tgCalls: TgCall[] = []
const realFetch = globalThis.fetch
const VOICE_TEXT = "Bahromga 2 ta Samsung 25W qarzga"

beforeEach(() => {
  tgCalls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://tg.mock/file/')) return new Response(new TextEncoder().encode(VOICE_TEXT))
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      geminiCalls.push(body)
      geminiUrls.push(url)
      if (geminiFail || (geminiMainQuota && !url.includes('flash-lite'))) return Response.json({ error: { message: 'quota' } }, { status: 429 })
      const parts = body.contents.at(-1).parts
      const audio = parts.find((x: any) => x.inlineData)
      const text = audio ? new TextDecoder().decode(Uint8Array.from(atob(audio.inlineData.data), (c) => c.charCodeAt(0))) : parts[0].text
      const ex = ANSWERS[text] ?? X({ action: 'unknown', question: 'Nima qilay?' })
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: text, ...ex }) }] } }] })
    }
    if (url.startsWith('https://cbu.uz/')) {
      return Response.json([{ Ccy: 'USD', Rate: '12850.50', Nominal: '1', Date: '07.11.2026' }, { Ccy: 'RUB', Rate: '158.20', Nominal: '1', Date: '07.11.2026' }])
    }
    if (url.startsWith('https://tg.mock/')) {
      const method = url.split('/').pop()!
      const body = JSON.parse(String(init?.body ?? '{}'))
      tgCalls.push({ method, body })
      if (method === 'getFile') return Response.json({ ok: true, result: { file_path: 'voice/f1.oga', file_size: 40 } })
      return Response.json({ ok: true, result: { message_id: 1 } })
    }
    return realFetch(input as RequestInfo, init)
  })
})
afterEach(() => { vi.restoreAllMocks() })

const X = (p: Partial<Extraction>): Extraction => ({
  action: 'unknown', customer: null, items: [], people: [], amount: null, method: null, paid: null,
  category: null, supplier: null, note: null, language: 'uz', currency: null, question: null, revises: false, rate: null, report: null, period: null, ...p,
})
const ANSWERS: Record<string, Extraction> = {
  [VOICE_TEXT]: X({ action: 'sale', customer: 'Bahrom', items: [{ product: 'Samsung 25W', qty: 2, price: null, cost: null, unit: null }], method: 'debt' }),
  'Bahrom 50 ming to\'ladi': X({ action: 'payment_in', customer: 'Bahrom', amount: 50000, method: 'cash' }),
  'Ijaraga 2 mln berdim': X({ action: 'expense', amount: 2_000_000, category: 'Ijara' }),
  'Yangi tovar Galaxy 1100 dollar': X({ action: 'product', currency: 'USD', items: [{ product: 'Galaxy S26', qty: 3, price: 1100, cost: 1000, unit: null }] }),
  'Galaxy emas, Pixel 10 dedim': X({ action: 'product', currency: 'USD', revises: true, items: [{ product: 'Pixel 10', qty: 3, price: 1100, cost: 1000, unit: null }] }),
  'Abdullohdan 500 ming oldim': X({ action: 'payment_in', customer: 'Abdulloh', amount: 500_000, method: 'cash' }),
  'Yana iPhone 18 1800 dollar': X({ action: 'product', currency: 'USD', items: [{ product: 'iPhone 18', qty: 1, price: 1800, cost: null, unit: null }] }),
  "Bahrom aka 3 million qarzi bor, Ma'ruf aka 1 million haqi bor": X({ action: 'customer', people: [
    { name: 'Bahrom aka', phone: null, owes: 3_000_000, owed: null },
    { name: "Ma'ruf aka", phone: null, owes: null, owed: 1_000_000 },
  ] }),
}
let aiCalls: string[] = []
let lastSystem = ''
let geminiCalls: any[] = []
let geminiFail = false
let geminiMainQuota = false
let geminiUrls: string[] = []
const fakeAi: AiRunner = {
  async run(model, input) {
    aiCalls.push(model)
    if (model.includes('whisper')) {
      const bin = atob(String(input.audio))
      return { text: new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))) }
    }
    // Joriy xabar — oxirgisi (oldinda tizim ko'rsatmasi va suhbat tarixi bo'lishi mumkin).
    lastSystem = (input.messages as { role: string; content: string }[])[0].content
    const text = (input.messages as { content: string }[]).at(-1)!.content
    return { response: ANSWERS[text] ?? X({ action: 'unknown', question: 'Nima qilay?' }) }
  },
}

type Env2 = typeof env & { AI?: AiRunner; AI_DAILY_LIMIT?: string }
async function call(path: string, init: { body?: unknown; raw?: Uint8Array; type?: string; token?: string; headers?: Record<string, string>; env?: Partial<Env2> } = {}) {
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  let body: BodyInit | undefined
  if (init.raw) { body = init.raw; headers['Content-Type'] = init.type ?? 'audio/ogg' }
  else if (init.body !== undefined) { body = JSON.stringify(init.body); headers['Content-Type'] = 'application/json' }
  const e = { ...env, AI: fakeAi, ...(init.env ?? {}) } as Env2
  const res = await route(new Request(`https://kassa.test${path}`, { method: 'POST', headers, body }), e as never, ctx)
  await Promise.all(pending)
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* */ }
  return { status: res.status, json }
}

let nextUid = 8_000_000
async function onboard() {
  const user = { id: ++nextUid, first_name: 'Zafar', language_code: 'uz' }
  const initData = await signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAE', user: JSON.stringify(user) }, env.BOT_TOKEN)
  const r = await call('/api/onboard', { body: { initData, shopName: 'AI do\'kon' } })
  const token = r.json.token as string
  const rpc = (op: string, args: unknown[] = []) => call(`/api/rpc/${op}`, { token, body: { args } })
  await rpc('saveProduct', [{ name: 'Samsung 25W zaryadka', price: 80000, cost_price: 50000, unit: 'dona' }])
  await rpc('saveCustomer', ["Bahrom do'kon", null])
  await rpc('openShift', [0])
  return { user, token, rpc, shopId: r.json.shop.id as string }
}

describe('assistant over HTTP', () => {
  it('text → draft (nothing written) → apply once, even if confirmed twice', async () => {
    aiCalls = []
    const a = await onboard()
    const p = await call('/api/assistant/parse', { token: a.token, body: { text: VOICE_TEXT } })
    expect(p.status).toBe(200)
    expect(aiCalls).toEqual(['@cf/meta/llama-3.3-70b-instruct-fp8-fast'])
    const d = p.json.data
    expect(d).toMatchObject({ kind: 'sale', customerName: "Bahrom do'kon", method: 'debt' })
    expect((await a.rpc('listSales', [{}])).json.data).toHaveLength(0)

    // Qoldiq yetadimi — test sozlamasiga bog'liq bo'lmasin: ruxsat beramiz.
    await a.rpc('setSetting', ['allow_negative_stock', '1'])
    const ap = await call('/api/assistant/apply', { token: a.token, body: { id: d.id } })
    expect(ap.json).toMatchObject({ ok: true, data: { status: 'applied', result: { total: 160000, debt: 160000 } } })
    const again = await call('/api/assistant/apply', { token: a.token, body: { id: d.id } })
    expect(again.json.ok).toBe(true)
    expect((await a.rpc('listSales', [{}])).json.data).toHaveLength(1)
  })

  it('voice upload goes through speech-to-text first', async () => {
    aiCalls = []
    const a = await onboard()
    const p = await call('/api/assistant/parse', { token: a.token, raw: new TextEncoder().encode("Bahrom 50 ming to'ladi"), type: 'audio/webm' })
    expect(aiCalls[0]).toContain('whisper')
    expect(p.json.data).toMatchObject({ kind: 'payment_in', amount: 50000, transcript: "Bahrom 50 ming to'ladi", source: 'voice', ready: true })
  })

  it('greets once per chat a day; replies in the app language when the message is ambiguous; reports come from the base', async () => {
    const a = await onboard()
    const first = await call('/api/assistant/parse', { token: a.token, body: { text: 'Sava', chatId: '', lang: 'ru' } })
    expect(lastSystem).toContain('if there are none — Russian')
    expect(lastSystem).not.toContain('do NOT greet again')
    const chatId = first.json.data.chatId as string
    await call('/api/assistant/parse', { token: a.token, body: { text: 'Qalaysan', chatId, lang: 'uz' } })
    expect(lastSystem).toContain('do NOT greet again')
    // Yangi chat — yangi suhbat (salom mumkin).
    await call('/api/assistant/parse', { token: a.token, body: { text: 'Salom', chatId: '', lang: 'uz' } })
    expect(lastSystem).not.toContain('do NOT greet again')
  })

  it('chats: a new chat is opened on the first message, continued by id, listed, and private to its owner', async () => {
    const a = await onboard()
    const first = await call('/api/assistant/parse', { token: a.token, body: { text: 'Ijaraga 2 mln berdim', chatId: '', lang: 'uz' } })
    const chatId = first.json.data.chatId as string
    expect(chatId).toMatch(/^[a-f0-9]{16}$/)
    expect(first.json.data.item).toMatchObject({ user: { kind: 'text', text: 'Ijaraga 2 mln berdim' }, reply: { kind: 'card', status: 'open', ready: true } })
    expect(first.json.data.item.reply.html).toContain('Xarajat')
    expect(first.json.data.item.reply.html).not.toContain('🗣')
    // Ovoz shu chatda davom etadi (X-Chat-Id), to'lqin saqlanadi.
    const v = await call('/api/assistant/parse', { token: a.token, raw: new TextEncoder().encode("Bahrom 50 ming to'ladi"), type: 'audio/webm', headers: { 'X-Chat-Id': chatId, 'X-Voice': JSON.stringify({ ms: 2100, wave: [0.1, 0.9, 7] }) } })
    expect(v.json.data.chatId).toBe(chatId)
    expect(v.json.data.item.user).toMatchObject({ kind: 'voice', voice: { ms: 2100, wave: [0.1, 0.9, 0] } })

    const chats = await call('/api/assistant/chats', { token: a.token })
    expect(chats.json.data).toEqual([expect.objectContaining({ id: chatId, title: 'Ijaraga 2 mln berdim', count: 2 })])
    // Kartadan tasdiqlash — tarixda "Saqlandi".
    await call('/api/assistant/apply', { token: a.token, body: { id: first.json.data.item.id } })
    const hist = await call('/api/assistant/chat', { token: a.token, body: { id: chatId, lang: 'uz' } })
    expect(hist.json.data.map((x: any) => [x.user.text, x.reply.status])).toEqual([['Ijaraga 2 mln berdim', 'saved'], ["Bahrom 50 ming to'ladi", 'open']])
    expect(hist.json.data[0].reply.html).toContain('Saqlandi')

    // Boshqa do'kon a'zosi bu chatni ko'rmaydi; chatId'ni bilsa ham davom ettira olmaydi (o'ziga yangi chat).
    const b = await onboard()
    expect((await call('/api/assistant/chat', { token: b.token, body: { id: chatId } })).status).toBe(404)
    const other = await call('/api/assistant/parse', { token: b.token, body: { text: 'Ijaraga 2 mln berdim', chatId } })
    expect(other.json.data.chatId).not.toBe(chatId)
    // Chatsiz (eski klient) rejim o'zgarmagan.
    const legacy = await call('/api/assistant/parse', { token: a.token, body: { text: 'Ijaraga 2 mln berdim' } })
    expect(legacy.json.data.item).toBeUndefined()
    // O'chirish.
    expect((await call('/api/assistant/chat-delete', { token: a.token, body: { id: chatId } })).status).toBe(200)
    expect((await call('/api/assistant/chats', { token: a.token })).json.data).toEqual([])
  })

  it('daily quota, disabled AI and bad input', async () => {
    const a = await onboard()
    const lim = { AI_DAILY_LIMIT: '1' }
    expect((await call('/api/assistant/parse', { token: a.token, body: { text: 'Ijaraga 2 mln berdim' }, env: lim })).status).toBe(200)
    expect((await call('/api/assistant/parse', { token: a.token, body: { text: 'Ijaraga 2 mln berdim' }, env: lim })).json.error.code).toBe('cloud.ai.errors.quota')
    expect((await call('/api/assistant/parse', { token: a.token, body: { text: 'x' }, env: { AI: undefined } })).status).toBe(503)
    expect((await call('/api/assistant/parse', { token: a.token, body: { text: '' } })).status).toBe(400)
    expect((await call('/api/assistant/apply', { token: a.token, body: { id: 'nope' } })).status).toBe(400)
    expect((await call('/api/assistant/parse', { body: { text: 'x' } })).status).toBe(401)
  })
})

describe('assistant with Gemini', () => {
  const G = { GEMINI_API_KEY: 'test-gemini-key' }
  it('voice goes to Gemini in one call (no Workers AI), with earlier messages as context', async () => {
    aiCalls = []; geminiCalls = []; geminiFail = false
    const a = await onboard()
    const r1 = await call('/api/assistant/parse', { token: a.token, body: { text: 'Ijaraga 2 mln berdim' }, env: G })
    expect(r1.json.data).toMatchObject({ kind: 'expense', amount: 2_000_000 })
    const r2 = await call('/api/assistant/parse', { token: a.token, raw: new TextEncoder().encode("Bahrom 50 ming to'ladi"), type: 'audio/ogg', env: G })
    expect(r2.json.data).toMatchObject({ kind: 'payment_in', transcript: "Bahrom 50 ming to'ladi" })
    expect(aiCalls).toEqual([])
    const last = geminiCalls.at(-1)
    expect(last.contents.at(-1).parts[0].inlineData.mimeType).toBe('audio/ogg')
    // Oldingi xabar kontekstda: foydalanuvchi matni + yordamchi nimani tushungani.
    expect(last.contents[0]).toMatchObject({ role: 'user', parts: [{ text: 'Ijaraga 2 mln berdim' }] })
    expect(last.contents[1].role).toBe('model')
  })

  it('main Gemini model out of quota → the lite model answers before Workers AI is touched', async () => {
    aiCalls = []; geminiUrls = []; geminiMainQuota = true
    const a = await onboard()
    const r = await call('/api/assistant/parse', { token: a.token, body: { text: 'Ijaraga 2 mln berdim' }, env: G })
    expect(r.json.data).toMatchObject({ kind: 'expense' })
    expect(geminiUrls.map((u) => u.split('/models/')[1].split(':')[0])).toEqual(['gemini-3.5-flash', 'gemini-3.5-flash-lite'])
    expect(aiCalls).toEqual([])
    geminiMainQuota = false
  })

  it('falls back to Workers AI when Gemini fails', async () => {
    aiCalls = []; geminiCalls = []; geminiFail = true
    const a = await onboard()
    const r = await call('/api/assistant/parse', { token: a.token, body: { text: 'Ijaraga 2 mln berdim' }, env: G })
    expect(geminiCalls.length).toBeGreaterThan(0)
    expect(aiCalls).toContain('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
    expect(r.json.data).toMatchObject({ kind: 'expense' })
    geminiFail = false
  })
})

describe('assistant in the bot chat', () => {
  const hook = (update: unknown) => call('/tg/webhook', { body: update, headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' } })

  it('voice message → confirmation card → ✅ writes the sale; others cannot press it', async () => {
    const a = await onboard()
    await a.rpc('setSetting', ['allow_negative_stock', '1'])
    await hook({ message: { message_id: 77, chat: { id: a.user.id, type: 'private' }, from: { id: a.user.id, language_code: 'uz' }, voice: { file_id: 'F1', duration: 4 } } })
    const card = tgCalls.filter((c) => c.method === 'sendMessage').pop()!
    // Javob foydalanuvchining ovozli xabariga reply.
    expect(card.body.reply_parameters).toMatchObject({ message_id: 77 })
    expect(card.body.text).toContain('Sotuv')
    expect(card.body.text).toContain("Bahrom do'kon")
    const confirm = card.body.reply_markup.inline_keyboard[0][0]
    expect(confirm.callback_data).toMatch(/^a:[a-f0-9]{16}$/)
    expect(card.body.reply_markup.inline_keyboard[1][0].web_app.url).toMatch(/\?draft=[a-f0-9]{16}$/)

    // Begona (a'zo emas) bosa olmaydi.
    await hook({ callback_query: { id: 'q0', from: { id: 1 }, data: confirm.callback_data, message: { chat: { id: a.user.id }, message_id: 5 } } })
    expect((await a.rpc('listSales', [{}])).json.data).toHaveLength(0)

    await hook({ callback_query: { id: 'q1', from: { id: a.user.id, language_code: 'uz' }, data: confirm.callback_data, message: { chat: { id: a.user.id }, message_id: 5 } } })
    const edited = tgCalls.filter((c) => c.method === 'editMessageText').pop()!
    expect(edited.body.text).toContain('Saqlandi')
    expect((await a.rpc('listSales', [{}])).json.data).toHaveLength(1)
    // Takror bosish — ikkinchi chek yo'q.
    await hook({ callback_query: { id: 'q2', from: { id: a.user.id }, data: confirm.callback_data, message: { chat: { id: a.user.id }, message_id: 5 } } })
    expect((await a.rpc('listSales', [{}])).json.data).toHaveLength(1)
  })

  it('new customers from a chat message: card lists balances, ✅ creates them', async () => {
    const a = await onboard()
    await hook({ message: { message_id: 9, chat: { id: a.user.id, type: 'private' }, from: { id: a.user.id, language_code: 'uz' }, text: "Bahrom aka 3 million qarzi bor, Ma'ruf aka 1 million haqi bor" } })
    const card = tgCalls.filter((c) => c.method === 'sendMessage').pop()!
    expect(card.body.text).toContain('Yangi mijoz')
    expect(card.body.text).toContain('<b>Bahrom aka</b> — qarzi 3 000 000')
    expect(card.body.text).toContain("<b>Ma'ruf aka</b> — haqi 1 000 000")
    const confirm = card.body.reply_markup.inline_keyboard[0][0]
    await hook({ callback_query: { id: 'q1', from: { id: a.user.id, language_code: 'uz' }, data: confirm.callback_data, message: { chat: { id: a.user.id }, message_id: 5 } } })
    expect(tgCalls.filter((c) => c.method === 'editMessageText').pop()!.body.text).toContain("2 ta mijoz qo'shildi")
    const list = (await a.rpc('listCustomers', [])).json.data as { name: string; balance: number }[]
    expect(Object.fromEntries(list.map((c) => [c.name, c.balance]))).toMatchObject({ 'Bahrom aka': -3_000_000, "Ma'ruf aka": 1_000_000 })
  })

  it('dollar prices: card offers the rate and saves converted in chat; a correction retires the old card', async () => {
    const a = await onboard()
    const say = (text: string, id: number) => hook({ message: { message_id: id, chat: { id: a.user.id, type: 'private' }, from: { id: a.user.id, language_code: 'uz' }, text } })
    await say('Yangi tovar Galaxy 1100 dollar', 10)
    const first = tgCalls.filter((c) => c.method === 'sendMessage').pop()!
    expect(first.body.text).toContain("1 $ = 12 850,5 so'm · MB kursi 07.11.2026")
    expect(first.body.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: "✅ so'mga o'tkazib saqlash", callback_data: expect.stringMatching(/^r:[a-f0-9]{16}:12850\.5$/) })

    // Tuzatish: eski karta (bot xabari #1) tugmalarsiz "Yangilandi" bo'ladi, yangisi to'liq.
    await say('Galaxy emas, Pixel 10 dedim', 11)
    const retired = tgCalls.filter((c) => c.method === 'editMessageText').pop()!
    expect(retired.body).toMatchObject({ chat_id: a.user.id, message_id: 1 })
    expect(retired.body.text).toContain('Yangilandi')
    expect(retired.body.reply_markup).toBeUndefined()
    const second = tgCalls.filter((c) => c.method === 'sendMessage').pop()!
    expect(second.body.text).toContain('Pixel 10')
    // Eski kartaning tugmasi endi ishlamaydi.
    const oldBtn = first.body.reply_markup.inline_keyboard[0][0].callback_data
    await hook({ callback_query: { id: 'q0', from: { id: a.user.id, language_code: 'uz' }, data: oldBtn, message: { chat: { id: a.user.id }, message_id: 1 } } })
    const names = async () => ((await a.rpc('listProducts', [true])).json.data as { name: string }[]).map((p) => p.name)
    expect(await names()).not.toContain('Galaxy S26')

    await hook({ callback_query: { id: 'q1', from: { id: a.user.id, language_code: 'uz' }, data: second.body.reply_markup.inline_keyboard[0][0].callback_data, message: { chat: { id: a.user.id }, message_id: 1 } } })
    expect(tgCalls.filter((c) => c.method === 'editMessageText').pop()!.body.text).toContain('Saqlandi')
    const products = (await a.rpc('listProducts', [true])).json.data as { name: string; price: number; cost_price: number; stock: number }[]
    expect(products.find((p) => p.name === 'Pixel 10')).toMatchObject({ price: 14_135_550, cost_price: 12_850_500, stock: 3 })
    expect(await names()).not.toContain('Galaxy S26')

    // Keyingi safar — do'konning o'z kursi taklif qilinadi.
    await say('Yana iPhone 18 1800 dollar', 12)
    expect(tgCalls.filter((c) => c.method === 'sendMessage').pop()!.body.text).toContain("1 $ = 12 850,5 so'm · oxirgi kursingiz")
  })

  it('AI switched off by the admin: no AI call, no quota, the bot and the app say it is off', async () => {
    const a = await onboard()
    await env.SHOP.getByName(a.shopId).setAiEnabled(false)
    aiCalls = []
    const r = await call('/api/assistant/parse', { token: a.token, body: { text: 'Ijaraga 2 mln berdim' } })
    expect(r.json).toMatchObject({ error: { code: 'cloud.ai.errors.disabled' } })
    await hook({ message: { message_id: 3, chat: { id: a.user.id, type: 'private' }, from: { id: a.user.id, language_code: 'uz' }, text: 'Ijaraga 2 mln berdim' } })
    expect(tgCalls.filter((c) => c.method === 'sendMessage').pop()!.body.text).toContain("AI yordamchi o'chirilgan")
    expect(aiCalls).toEqual([])
    await env.SHOP.getByName(a.shopId).setAiEnabled(true)
    expect((await call('/api/assistant/parse', { token: a.token, body: { text: 'Ijaraga 2 mln berdim' } })).json.data).toMatchObject({ kind: 'expense' })
  })

  it('payment from someone not in the base: the card says the customer will be added; ✅ creates both', async () => {
    const a = await onboard()
    await hook({ message: { message_id: 4, chat: { id: a.user.id, type: 'private' }, from: { id: a.user.id, language_code: 'uz' }, text: 'Abdullohdan 500 ming oldim' } })
    const card = tgCalls.filter((c) => c.method === 'sendMessage').pop()!
    expect(card.body.text).toContain("<b>Abdulloh</b> · 🆕 yangi mijoz, saqlashda qo'shiladi")
    const ok = card.body.reply_markup.inline_keyboard[0][0]
    expect(ok.callback_data).toMatch(/^a:/)
    await hook({ callback_query: { id: 'q1', from: { id: a.user.id, language_code: 'uz' }, data: ok.callback_data, message: { chat: { id: a.user.id }, message_id: 1 } } })
    const list = (await a.rpc('listCustomers', [])).json.data as { name: string; balance: number }[]
    expect(list.find((c) => c.name === 'Abdulloh')).toMatchObject({ balance: 500_000 })
  })

  it('plain text from a stranger gets a join hint, commands still work', async () => {
    await hook({ message: { chat: { id: 42, type: 'private' }, from: { id: 42, language_code: 'uz' }, text: 'Ijaraga 2 mln berdim' } })
    expect(tgCalls.filter((c) => c.method === 'sendMessage').pop()!.body.text).toContain('ulangan')
  })
})
