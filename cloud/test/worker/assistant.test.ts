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
// Haqiqiy xabar (2026-11-12): to'rtta amal bitta xabarda — model ularni rad etgan edi.
const MULTI = 'anvarga 500 ming\nbotirga 300 ming qarz berdim\n\nJamshiddan 200 ming qarz oldin\nKamol 400 ming qarzini berdi'

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
      if (method === 'sendWidget' && failWidget) return Response.json({ ok: false, description: 'Bad Request: WIDGET_NOT_AVAILABLE' }, { status: 400 })
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
  'Ijaraga 1 mln, 2 ta samsung zaryadka sotdim': X({ action: 'expense', amount: 1_000_000, category: 'Ijara', also: [
    X({ action: 'sale', items: [{ product: 'samsung zaryadka', qty: 2, price: null, cost: null, unit: null }], method: 'cash' }),
    X({ action: 'payment_in', amount: 50_000 }),
  ] }),
  [MULTI]: X({ action: 'payment_out', customer: 'Anvar', amount: 500_000, method: 'cash', also: [
    X({ action: 'payment_out', customer: 'Botir', amount: 300_000, method: 'cash' }),
    X({ action: 'payment_in', customer: 'Jamshid', amount: 200_000, method: 'cash' }),
    X({ action: 'payment_in', customer: 'Kamol', amount: 400_000, method: 'cash' }),
  ] }),
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
let failWidget = false
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

  it('several actions in one message: the chat gets one card each, the user bubble only once', async () => {
    const a = await onboard()
    const r = await call('/api/assistant/parse', { token: a.token, body: { text: MULTI, chatId: '', lang: 'uz' } })
    expect(r.json.data.item).toMatchObject({ user: { kind: 'text', text: MULTI }, reply: { kind: 'card', status: 'open', ready: true, kindName: 'payment_out' } })
    expect(r.json.data.more.map((x: any) => [x.user, x.reply.kindName, x.reply.ready])).toEqual([[null, 'payment_out', true], [null, 'payment_in', true], [null, 'payment_in', true]])
    expect(r.json.data.more[0].reply.html).toContain('Mijozga qarz berildi')
    const hist = await call('/api/assistant/chat', { token: a.token, body: { id: r.json.data.chatId, lang: 'uz' } })
    expect(hist.json.data.map((x: any) => [x.id, x.user?.text ?? null])).toEqual([[r.json.data.item.id, MULTI], ...r.json.data.more.map((x: any) => [x.id, null])])
    // Chatsiz (eski klient) rejim: keyingi amallar `more` da.
    const legacy = await call('/api/assistant/parse', { token: a.token, body: { text: MULTI } })
    expect(legacy.json.data.more.map((d: any) => d.customerQuery)).toEqual(['Botir', 'Jamshid', 'Kamol'])
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
  const say = (uid: number, text: string, id = 9) => hook({ message: { message_id: id, chat: { id: uid, type: 'private' }, from: { id: uid, language_code: 'uz' }, text } })
  // Tasdiqlash kartasi — widget (sendWidget); holat chat_data'da, tugmalar ostida (A:/X: + guruh id).
  const widget = () => tgCalls.filter((c) => c.method === 'sendWidget').pop()!
  const data = (c: TgCall) => JSON.parse(c.body.chat_data)
  const lastData = () => data(tgCalls.filter((c) => c.method === 'editMessageWidgetData').pop()!)
  const lastKeyboard = () => tgCalls.filter((c) => c.method === 'editMessageCaption').pop()!.body.reply_markup.inline_keyboard
  const press = (uid: number, cb: string) => hook({ callback_query: { id: 'q', from: { id: uid, language_code: 'uz' }, data: cb, message: { chat: { id: uid }, message_id: 1 } } })
  const ask = async (uid: number, q: string) => {
    tgCalls = []
    await hook({ widget_query: { id: 'wq', from: { id: uid, language_code: 'uz' }, chat: { id: uid, type: 'private' }, message_id: 1, chat_instance: '1', type: { type: 'data' }, data: q } })
    return tgCalls.find((c) => c.method === 'answerWidgetQuery')!.body.data as string
  }

  it('voice message → one widget card (reply to the voice) → ✅ writes the sale once; others cannot press it', async () => {
    const a = await onboard()
    await a.rpc('setSetting', ['allow_negative_stock', '1'])
    tgCalls = []
    await hook({ message: { message_id: 77, chat: { id: a.user.id, type: 'private' }, from: { id: a.user.id, language_code: 'uz' }, voice: { file_id: 'F1', duration: 4 } } })
    expect(tgCalls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
    const w = widget()
    expect(w.body).toMatchObject({ chat_id: a.user.id, allow_queries: true, parse_mode: 'HTML', reply_parameters: { message_id: 77 } })
    expect(w.body.caption).toBe("🧾 Sotuv · Bahrom do'kon · 160 000 so'm")
    const d = data(w)
    expect(d.l).toEqual([expect.objectContaining({ k: 's', s: 'o', n: "Bahrom do'kon", m: 'd', a: 160_000, it: [['Samsung 25W zaryadka', 2, 80_000, 'dona', 1]], pe: 1 })])
    const [[confirm, cancel], [open]] = w.body.reply_markup.inline_keyboard
    expect(confirm).toEqual({ text: '✅ Tasdiqlash', callback_data: `A:${d.g}` })
    expect(cancel.callback_data).toBe(`X:${d.g}`)
    expect(open.web_app.url).toBe(`https://kassa.test/?draft=${d.g}`)

    // Begona (a'zo emas) bosa olmaydi.
    await press(1, confirm.callback_data)
    expect((await a.rpc('listSales', [{}])).json.data).toHaveLength(0)
    await press(a.user.id, confirm.callback_data)
    expect((await a.rpc('listSales', [{}])).json.data).toHaveLength(1)
    expect(lastData().l[0]).toMatchObject({ s: 's', res: expect.stringMatching(/^#/) })
    expect(lastKeyboard()).toEqual([]) // hammasi saqlandi — tugmalar olib tashlanadi
    // Takror bosish — ikkinchi chek yo'q.
    await press(a.user.id, confirm.callback_data)
    expect((await a.rpc('listSales', [{}])).json.data).toHaveLength(1)
  })

  it('new customers from a chat message: the card lists balances, ✅ creates them', async () => {
    const a = await onboard()
    await say(a.user.id, "Bahrom aka 3 million qarzi bor, Ma'ruf aka 1 million haqi bor")
    const d = data(widget())
    expect(d.l[0]).toMatchObject({ k: 'c', pp: [['Bahrom aka', 'd', 3_000_000], ["Ma'ruf aka", 'c', 1_000_000]] })
    // Widget'da: birinchisining summasini o'zgartirish.
    expect(await ask(a.user.id, `yh:${d.g}:0:2500000`)).toBe('ok')
    expect(lastData().l[0].pp[0]).toEqual(['Bahrom aka', 'd', 2_500_000])
    await press(a.user.id, `A:${d.g}`)
    expect(lastData().l[0]).toMatchObject({ s: 's', res: '(2 ta)' })
    const list = (await a.rpc('listCustomers', [])).json.data as { name: string; balance: number }[]
    expect(Object.fromEntries(list.map((c) => [c.name, c.balance]))).toMatchObject({ 'Bahrom aka': -2_500_000, "Ma'ruf aka": 1_000_000 })
  })

  it('dollar prices: the card converts at the offered rate; a correction retires the old card; the rate is remembered', async () => {
    const a = await onboard()
    await say(a.user.id, 'Yangi tovar Galaxy 1100 dollar', 10)
    const first = data(widget())
    expect(first.l[0]).toMatchObject({ k: 'p', cu: 'USD', fx: 12_850.5, it: [['Galaxy S26', 3, 1100, 'dona', 1]] })
    expect(first.l[0].w[0]).toContain("saqlashda so'mga o'tkaziladi")

    // Tuzatish: yangi karta, eski karta "yangilandi" va tugmalarsiz.
    tgCalls = []
    await say(a.user.id, 'Galaxy emas, Pixel 10 dedim', 11)
    const second = data(widget())
    expect(second.l[0].it[0][0]).toBe('Pixel 10')
    expect(lastData()).toMatchObject({ g: first.g, l: [expect.objectContaining({ s: 'u' })] })
    expect(lastKeyboard()).toEqual([])
    // Eski kartaning tugmasi endi hech narsa yozmaydi.
    await press(a.user.id, `A:${first.g}`)
    const names = async () => ((await a.rpc('listProducts', [true])).json.data as { name: string }[]).map((p) => p.name)
    expect(await names()).not.toContain('Galaxy S26')

    // Kurs bilan o'tkazish (widget ichida) → tayyor → ✅.
    expect(await ask(a.user.id, `yr:${second.g}:12850.5`)).toBe('ok')
    expect(lastData().l[0]).toMatchObject({ it: [['Pixel 10', 3, 14_135_550, 'dona', 1]] })
    expect(lastData().l[0].cu).toBeUndefined()
    await press(a.user.id, `A:${second.g}`)
    const products = (await a.rpc('listProducts', [true])).json.data as { name: string; price: number; cost_price: number; stock: number }[]
    expect(products.find((p) => p.name === 'Pixel 10')).toMatchObject({ price: 14_135_550, cost_price: 12_850_500, stock: 3 })
    expect(await names()).not.toContain('Galaxy S26')

    // Keyingi safar — do'konning o'z kursi taklif qilinadi.
    await say(a.user.id, 'Yana iPhone 18 1800 dollar', 12)
    expect(data(widget()).l[0].fx).toBe(12_850.5)
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
    await say(a.user.id, 'Abdullohdan 500 ming oldim', 4)
    const w = widget()
    expect(w.body.caption).toBe("💵 Mijozdan to'lov · Abdulloh · 500 000 so'm")
    expect(data(w).l[0]).toMatchObject({ k: 'i', n: 'Abdulloh', nw: 1, m: 'c', a: 500_000 })
    await press(a.user.id, `A:${data(w).g}`)
    const list = (await a.rpc('listCustomers', [])).json.data as { name: string; balance: number }[]
    expect(list.find((c) => c.name === 'Abdulloh')).toMatchObject({ balance: 500_000 })
  })

  it('several actions in one message: ONE card with a row each; a row is removed in the card, the rest confirmed together', async () => {
    const a = await onboard()
    tgCalls = []
    await say(a.user.id, MULTI, 31)
    expect(tgCalls.filter((c) => c.method === 'sendWidget')).toHaveLength(1)
    expect(tgCalls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
    const w = widget()
    expect(w.body.reply_parameters).toMatchObject({ message_id: 31 })
    expect(w.body.caption).toBe("🧾 4 ta amal: Anvar 500 000 so'm, Botir 300 000 so'm, Jamshid 200 000 so'm, Kamol 400 000 so'm")
    expect(w.body.reply_markup.inline_keyboard[0][0].text).toBe('✅ Hammasini tasdiqlash')
    const d = data(w)
    expect(d.l.map((r: any) => [r.k, r.n, r.a, r.nw])).toEqual([['o', 'Anvar', 500_000, 1], ['o', 'Botir', 300_000, 1], ['i', 'Jamshid', 200_000, 1], ['i', 'Kamol', 400_000, 1]])
    // Ikkinchisi — kartaning o'zida ✕.
    expect(await ask(a.user.id, `yx:${d.l[1].i}`)).toBe('ok')
    expect(lastData().l.map((r: any) => r.s)).toEqual(['o', 'x', 'o', 'o'])
    await press(a.user.id, `A:${d.g}`)
    expect(lastData().l.map((r: any) => r.s)).toEqual(['s', 'x', 's', 's'])
    const list = (await a.rpc('listCustomers', [])).json.data as { id: number; name: string; balance: number }[]
    const bal = Object.fromEntries(list.map((c) => [c.name, c.balance]))
    expect(bal).toMatchObject({ Anvar: -500_000, Jamshid: 200_000, Kamol: 400_000 })
    expect(bal.Botir).toBeUndefined()
    // Mijoz sahifasidagi to'lovlar: qarz berish manfiy yozuv.
    expect((await a.rpc('customerPayments', [list.find((c) => c.name === 'Anvar')!.id])).json.data).toMatchObject([{ amount: -500_000, method: 'cash' }])
  })

  it('editing inside the card: amount, method, category, customer, product, quantity; not-ready rows block ✅', async () => {
    const a = await onboard()
    const p45 = (await a.rpc('saveProduct', [{ name: 'Samsung 45W zaryadka', price: 150000, cost_price: 100000, unit: 'dona' }])).json.data as number
    await a.rpc('setSetting', ['allow_negative_stock', '1'])
    await say(a.user.id, 'Ijaraga 1 mln, 2 ta samsung zaryadka sotdim')
    const d = data(widget())
    const [exp, sale, pay] = d.l
    expect([exp.k, sale.k, pay.k]).toEqual(['e', 's', 'i'])
    expect(sale.it[0]).toEqual(['samsung zaryadka', 2, null, '', 0, expect.arrayContaining([[p45, 'Samsung 45W zaryadka']])])
    expect(pay.w).toEqual(["Qaysi mijoz to'laganini ayting"])

    // ✅ — tayyor bo'lmagan qatorlar bor: hech narsa yozilmaydi, sabab ko'rsatiladi.
    tgCalls = []
    await press(a.user.id, `A:${d.g}`)
    const alert = tgCalls.find((c) => c.method === 'answerCallbackQuery')!.body
    expect(alert.show_alert).toBe(true)
    expect(alert.text).toContain('2. «samsung zaryadka» — qaysi tovar?')
    expect((await a.rpc('listSales', [{}])).json.data).toHaveLength(0)

    expect(await ask(a.user.id, `ya:${exp.i}:1200000`)).toBe('ok')
    expect(await ask(a.user.id, `yg:${exp.i}:2`)).toBe('ok') // Kommunal
    expect(lastData().l[0]).toMatchObject({ a: 1_200_000, g: 'Kommunal' })
    expect(await ask(a.user.id, `yi:${sale.i}:0:p:${p45}`)).toBe('ok')
    expect(await ask(a.user.id, `yi:${sale.i}:0:q:3`)).toBe('ok')
    expect(await ask(a.user.id, `ym:${sale.i}:k`)).toBe('ok')
    expect(lastData().l[1]).toMatchObject({ m: 'k', a: 450_000, it: [['Samsung 45W zaryadka', 3, 150_000, 'dona', 1]] })
    const bahrom = ((await a.rpc('listCustomers', [])).json.data as { id: number; name: string }[]).find((c) => c.name === "Bahrom do'kon")!.id
    expect(await ask(a.user.id, `yc:${pay.i}:${bahrom}`)).toBe('ok')
    expect(lastData().l[2]).toMatchObject({ n: "Bahrom do'kon", a: 50_000 })
    expect(lastData().l[2].w).toBeUndefined()

    // Yaroqsiz tahrir, begona odam, saqlangandan keyin.
    expect(await ask(a.user.id, `ym:${exp.i}:d`)).toBe('bad') // xarajatda usul yo'q
    expect(await ask(a.user.id, `ya:${exp.i}:-5`)).toBe('bad')
    expect(await ask(a.user.id, 'yz:0000000000000000')).toBe('bad')
    expect(await ask(424242, `ya:${exp.i}:1`)).toBe('forbidden')
    await press(a.user.id, `A:${d.g}`)
    expect(lastData().l.map((r: any) => r.s)).toEqual(['s', 's', 's'])
    expect(await ask(a.user.id, `ya:${exp.i}:1`)).toBe('gone')
    const sales = (await a.rpc('listSales', [{}])).json.data as { total: number; paid_card: number }[]
    expect(sales).toMatchObject([{ total: 450_000, paid_card: 450_000 }])
  })

  it('✏️ under the card opens EVERY action of the message in the app; "confirm all" there writes them once and updates the card', async () => {
    const a = await onboard()
    await say(a.user.id, MULTI, 41)
    const w = widget()
    const d = data(w)
    expect(w.body.reply_markup.inline_keyboard.at(-1)[0].web_app.url).toContain(`?draft=${d.l[0].i}`)
    // Guruhning istalgan amali — butun guruh, aytilgan tartibda; foydalanuvchi matni faqat birinchisida.
    const gr = await call('/api/assistant/group', { token: a.token, body: { id: d.l[2].i, lang: 'uz' } })
    expect(gr.json.data.g).toBe(d.g)
    expect(gr.json.data.items.map((x: any) => [x.id, x.reply.kindName, x.reply.status, x.user?.text ?? null])).toEqual([
      [d.l[0].i, 'payment_out', 'open', MULTI], [d.l[1].i, 'payment_out', 'open', null],
      [d.l[2].i, 'payment_in', 'open', null], [d.l[3].i, 'payment_in', 'open', null],
    ])
    expect(gr.json.data.items[0].reply.html).toContain('Anvar')
    await call('/api/assistant/cancel', { token: a.token, body: { id: d.l[1].i } })
    tgCalls = []
    const ap = await call('/api/assistant/group-apply', { token: a.token, body: { id: d.g, lang: 'uz' } })
    expect(ap.json.data).toMatchObject({ notReady: [], errors: [] })
    expect(ap.json.data.items.map((x: any) => x.reply.status)).toEqual(['saved', 'cancelled', 'saved', 'saved'])
    expect(lastData().l.map((r: any) => r.s)).toEqual(['s', 'x', 's', 's'])
    // Qayta bosish — ikki marta yozilmaydi.
    await call('/api/assistant/group-apply', { token: a.token, body: { id: d.g } })
    const bal = Object.fromEntries(((await a.rpc('listCustomers', [])).json.data as { name: string; balance: number }[]).map((c) => [c.name, c.balance]))
    expect(bal).toMatchObject({ Anvar: -500_000, Jamshid: 200_000, Kamol: 400_000 })
    expect(bal.Botir).toBeUndefined()
    // Begona do'kon/odam — topilmaydi; yaroqsiz id — 400.
    const b = await onboard()
    expect((await call('/api/assistant/group', { token: b.token, body: { id: d.g } })).status).toBe(404)
    expect((await call('/api/assistant/group', { token: a.token, body: { id: 'x' } })).status).toBe(400)
    expect((await call('/api/assistant/group', { body: { id: d.g } })).status).toBe(401)
  })

  it('"confirm all" in the app writes nothing while an action still needs fixing, and says which one', async () => {
    const a = await onboard()
    await a.rpc('saveProduct', [{ name: 'Samsung 45W zaryadka', price: 150000, cost_price: 100000, unit: 'dona' }])
    await say(a.user.id, 'Ijaraga 1 mln, 2 ta samsung zaryadka sotdim')
    const d = data(widget())
    const ap = await call('/api/assistant/group-apply', { token: a.token, body: { id: d.l[0].i, lang: 'uz' } })
    expect(ap.json.data.notReady).toEqual([2, 3])
    expect(ap.json.data.items.map((x: any) => x.reply.status)).toEqual(['open', 'open', 'open'])
    expect((await a.rpc('listExpenses', [{}])).json.data ?? []).toHaveLength(0)
    // "Bekor" — guruhning hamma ochiq amali bekor, bot kartasi ham yangilanadi.
    tgCalls = []
    const cn = await call('/api/assistant/group-cancel', { token: a.token, body: { id: d.g, lang: 'uz' } })
    expect(cn.json.data.items.map((x: any) => x.reply.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(lastData().l.map((r: any) => r.s)).toEqual(['x', 'x', 'x'])
  })

  it('a client without widgets: if sendWidget fails, the old text cards are sent and still work', async () => {
    const a = await onboard()
    failWidget = true
    try {
      tgCalls = []
      await say(a.user.id, MULTI, 5)
      const cards = tgCalls.filter((c) => c.method === 'sendMessage')
      expect(cards).toHaveLength(4)
      expect(cards[0].body.text).toContain('Mijozga qarz berildi')
      await press(a.user.id, cards[0].body.reply_markup.inline_keyboard[0][0].callback_data)
      const list = (await a.rpc('listCustomers', [])).json.data as { name: string; balance: number }[]
      expect(list.find((c) => c.name === 'Anvar')).toMatchObject({ balance: -500_000 })
    } finally { failWidget = false }
  })

  it('a change made in the app updates the bot card', async () => {
    const a = await onboard()
    await say(a.user.id, 'Ijaraga 2 mln berdim')
    const d = data(widget())
    tgCalls = []
    await call('/api/assistant/update', { token: a.token, body: { id: d.g, edits: { amount: 2_500_000 } } })
    expect(lastData().l[0]).toMatchObject({ a: 2_500_000 })
    await call('/api/assistant/apply', { token: a.token, body: { id: d.g } })
    expect(lastData().l[0].s).toBe('s')
    expect(lastKeyboard()).toEqual([])
  })

  it('plain text from a stranger gets a join hint, commands still work', async () => {
    await hook({ message: { chat: { id: 42, type: 'private' }, from: { id: 42, language_code: 'uz' }, text: 'Ijaraga 2 mln berdim' } })
    expect(tgCalls.filter((c) => c.method === 'sendMessage').pop()!.body.text).toContain('ulangan')
  })
})
