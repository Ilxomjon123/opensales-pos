// Workers AI: ovoz → matn (Whisper) va matn → amal(lar) (LLM, JSON). Har qanday tilda.
// Bitta xabarda bir nechta amal bo'lishi mumkin ("Botirga 300 ming qarz berdim, Kamol 400 ming berdi") —
// birinchisi asosiy maydonlarda, qolganlari `also` da; har biri alohida qoralama/karta bo'ladi.
//
// AI faqat MATN chiqaradi (tovar/mijoz nomi qanday aytilgan bo'lsa) — id, qoldiq, narx qarori
// emas. Id'ga moslash va tekshiruv serverda (match.ts, shop/assistant.ts), yozish — foydalanuvchi
// tasdiqlagach oddiy op orqali. Model javobi sxemaga to'liq mos kelmasligi mumkin (Workers AI
// kafolat bermaydi) — shuning uchun `sanitize` har maydonni qayta tekshiradi.

import { REPORT_PERIODS, REPORT_TOPICS, type ReportPeriod, type ReportTopic } from '../shop/answers'

export const STT_MODEL = '@cf/openai/whisper-large-v3-turbo'
export const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

export type Kind = 'sale' | 'payment_in' | 'payment_out' | 'expense' | 'receipt' | 'product' | 'customer' | 'unknown'
export const KINDS: Kind[] = ['sale', 'payment_in', 'payment_out', 'expense', 'receipt', 'product', 'customer', 'unknown']
/** Bitta xabardagi amallar chegarasi (asosiy + `also`). */
export const MAX_ACTIONS = 8
export const EXPENSE_CATEGORIES = ['Ijara', 'Oylik', 'Kommunal', 'Tovar', 'Transport', 'Soliq', 'Boshqa']

export type Extraction = {
  action: Kind
  customer: string | null
  items: { product: string; qty: number | null; price: number | null; cost: number | null; unit: string | null }[]
  /** Faqat "customer": yangi mijozlar va boshlang'ich saldo (owes — u bizga qarz, owed — biz unga). */
  people: { name: string; phone: string | null; owes: number | null; owed: number | null }[]
  amount: number | null
  method: 'cash' | 'card' | 'debt' | 'transfer' | null
  paid: number | null
  category: string | null
  supplier: string | null
  note: string | null
  language: string | null
  /** Narx/summa qaysi valyutada aytilgan (do'kon valyutasidan farq qilsa — ogohlantirish). */
  currency: string | null
  question: string | null
  /** Xabar oldingi OCHIQ (hali saqlanmagan) so'rovni tuzatadi — javob o'sha so'rovning to'liq yangilangan nusxasi. */
  revises: boolean
  /** Foydalanuvchi aytgan kurs: 1 birlik aytilgan valyuta = rate do'kon valyutasi ("dollar 12 mingdan"). */
  rate: number | null
  /** Hisobot savoli ("umumiy qarz qancha?") — action "unknown" bo'ladi, javobni server bazadan hisoblaydi (shop/answers.ts). */
  report: ReportTopic | null
  period: ReportPeriod | null
  /** Shu xabardagi keyingi amallar (aytilgan tartibda); har biri alohida qoralama. Faqat yuqori darajada. */
  also?: Extraction[]
}

/** Suhbat konteksti: oldingi xabarlar ("yuqoridagi tovarlar", "o'shani" kabi gaplar uchun). */
export type Turn = { role: 'user' | 'assistant'; text: string }

/** Workers AI binding'ining bizga kerak qismi (testlarda soxtasi beriladi). */
export interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

export type ShopHints = {
  shopName: string
  currency: string
  products: string[]
  customers: string[]
  /** Ilova tili — qisqa/noaniq xabarga javob tili (bitta so'zdan til taxmin qilinmasin). */
  lang?: 'uz' | 'ru'
  /** Shu chatda (bot — shu odam bilan) oxirgi 12 soatda gaplashilgan — qayta salomlashilmaydi. */
  greeted?: boolean
}

/** Model ko'radigan amallar: KINDS + "report" (sanitize uni "unknown" + report ga aylantiradi). */
const MODEL_ACTIONS = [...KINDS, 'report'] as const

const MAX_AUDIO_BYTES = 2_000_000

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(bin)
}

/** Ovoz → matn. Til avtomatik; boshlang'ich izohda do'kon lug'ati (tovar/mijoz nomlari) — nomlarni to'g'ri yozishga yordam. */
export async function transcribe(ai: AiRunner, audio: Uint8Array, hints: ShopHints): Promise<string> {
  if (audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) throw new Error('audioSize')
  const vocab = [...hints.products.slice(0, 40), ...hints.customers.slice(0, 20)].join(', ')
  const out = (await ai.run(STT_MODEL, {
    audio: toBase64(audio),
    task: 'transcribe',
    vad_filter: true,
    initial_prompt: vocab ? `${hints.shopName}: ${vocab}.`.slice(0, 600) : undefined,
  })) as { text?: unknown }
  return typeof out?.text === 'string' ? out.text.trim() : ''
}

/** Bitta amal maydonlari (asosiy javob va `also` elementlari uchun umumiy). */
const ACTION_PROPS = {
  action: { type: 'string', enum: MODEL_ACTIONS },
  customer: { type: ['string', 'null'] },
  items: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        product: { type: 'string' }, qty: { type: ['number', 'null'] }, price: { type: ['number', 'null'] },
        cost: { type: ['number', 'null'] }, unit: { type: ['string', 'null'] },
      },
      required: ['product', 'qty', 'price', 'cost', 'unit'],
    },
  },
  people: {
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string' }, phone: { type: ['string', 'null'] }, owes: { type: ['number', 'null'] }, owed: { type: ['number', 'null'] } },
      required: ['name', 'phone', 'owes', 'owed'],
    },
  },
  amount: { type: ['number', 'null'] },
  method: { type: ['string', 'null'], enum: ['cash', 'card', 'debt', 'transfer', null] },
  paid: { type: ['number', 'null'] },
  category: { type: ['string', 'null'] },
  supplier: { type: ['string', 'null'] },
  note: { type: ['string', 'null'] },
  currency: { type: ['string', 'null'] },
  question: { type: ['string', 'null'] },
  report: { type: ['string', 'null'], enum: [...REPORT_TOPICS, null] },
  period: { type: ['string', 'null'], enum: [...REPORT_PERIODS, null] },
}
const ACTION_REQUIRED = Object.keys(ACTION_PROPS)

export const SCHEMA = {
  type: 'object',
  properties: {
    ...ACTION_PROPS,
    language: { type: ['string', 'null'] },
    revises: { type: 'boolean' },
    rate: { type: ['number', 'null'] },
    also: { type: 'array', items: { type: 'object', properties: ACTION_PROPS, required: ACTION_REQUIRED } },
  },
  required: [...ACTION_REQUIRED, 'language', 'revises', 'rate', 'also'],
}

export function systemPrompt(h: ShopHints): string {
  const appLang = h.lang === 'ru' ? 'Russian' : 'Uzbek (Latin script)'
  return [
    'You turn ONE message from a shopkeeper into the accounting action(s) it describes for their point-of-sale system (usually one).',
    'The message can be in ANY language or script (Uzbek Latin or Cyrillic, Russian, English, Tajik, Kazakh, Kyrgyz, Turkish, mixed). Understand it fully.',
    'Return ONLY a JSON object matching the schema. Actions:',
    '- "sale": goods were sold. items = what was sold (product, qty, price per unit only if said). customer = buyer name only if said.',
    '  method: "cash" (naqd/наличные), "card" (karta/карта/terminal), "debt" (qarzga/в долг/nasiya). paid = amount paid now only if a partial payment is said.',
    '- "payment_in": a person paid money TO the shop: debt repayment or prepayment ("Kamol qarzini berdi", "Ali 50 ming to\'ladi"), OR the shop BORROWED money from that person ("Jamshiddan 200 ming qarz oldim", "занял у X") — the shop then owes them. customer, amount, method: "cash" | "card" | "transfer".',
    '- "payment_out": the shop GAVE or LENT money to a person who must pay it back ("Anvarga 500 ming qarz berdim", "Botirga 300 ming qarzga pul berdim", "дал в долг X", "одолжил X") — that person now owes the shop more. customer, amount, method: "cash" | "card" | "transfer". This is NOT an expense.',
    `- "expense": the shop spent money for itself (rent, salary, utilities, transport, tax, other) — money lent to a person is "payment_out". amount, category = one of ${EXPENSE_CATEGORIES.join(', ')}, note = short description in the original language.`,
    '- "receipt": goods arrived INTO stock from a supplier. supplier, items with qty and price = purchase cost per unit.',
    '- "product": add NEW products to the catalog (create items that do not exist yet). items: product = the name exactly as said, price = selling price, cost = purchase price if said, qty = starting stock if said, unit (dona, kg, litr, metr, quti, blok, pachka) if said.',
    '- If the message introduces a new person AND says money was received from them (or goods were sold to them), it is "payment_in" (or "sale") with that customer — a missing customer is created automatically on confirm. Use "customer" only to register people with an existing balance and no money changing hands now.',
    '- "customer": add NEW customers (people the shop trades with). people: name as said (keep "aka/opa" if said), phone if said, owes = how much THIS PERSON OWES THE SHOP (qarzi bor, bizdan qarz, долг), owed = how much THE SHOP OWES THIS PERSON (haqi bor, haqdor, biz qarzmiz, предоплата, мы должны). Use only one of owes/owed per person; both null if no balance was said.',
    '  If asked to add/invent products without naming them (e.g. "add 10 test products"), use "product" with EMPTY items and ask in question which products (names and prices) to add. Never invent product names.',
    '- "report": a QUESTION about the shop\'s own numbers — nothing is recorded. report = the topic: "debts" (total debts, who owes how much, "pulimiz ko\'chada", "сколько нам должны"), "customer" (one customer\'s debt/balance; customer = the name as said), "sales" (how much was sold, revenue, profit, "savdo qancha", "выручка"), "cash" (money in the cash register / shift, "kassada qancha bor"), "stock" (how many are left; items = [the product as said] for one product, empty items for the whole stock / what is running out), "expenses" (how much was spent), "top_products" (best sellers). period: "today" (default when not said), "yesterday", "week" (last 7 days), "month" (this month), "last_month", "year", "all". question = null — the server computes the answer from the database. NEVER state shop numbers (debts, sales, cash, stock, profit) yourself in any reply — you do not know them; use "report".',
    '- "unknown": anything else — greetings, small talk ("qalaysan", "sava", "как дела"), thanks, questions about you. For "unknown" ALWAYS fill question with a warm, natural, human reply of one or two short sentences, like a friendly shop assistant who knows the user — answer what was said and add a short friendly follow-up (e.g. "Yaxshiman, rahmat! Savdolar qalay bugun?"), never a single dry word. Mention what you can do (with ONE concrete example) only when the user asks what you can do or this is the very first message of the chat — never repeat it reply after reply. Do not repeat the wording of your earlier replies in this chat.',
    h.greeted
      ? '  You ALREADY talked with this user earlier today: do NOT greet again (no "Assalomu alaykum", "Salom", "Здравствуйте", "Привет", "Hello" at the start) — just answer the message directly.'
      : '',
    `REPLY LANGUAGE (question and every text you write): the language and script the user writes in. Uzbek is often written informally or with slang — "sava", "salom", "qalesan", "qalaysan", "nima gap", "zo\'r", "rahmat", "jonim", "go\'zalim", "asalim", "aka", "ok" are Uzbek. If the message is too short or ambiguous to tell the language (one word, a name, slang, an emoji), use the language of the user\'s earlier messages in this chat; if there are none — ${appLang}. Never answer in a language the user has not used (no French, Spanish, Italian, Turkish, English for an Uzbek user).`,
    'Numbers: "50 ming" / "50 тысяч" / "50k" = 50000; "1,5 mln" / "полтора миллиона" = 1500000; "yarim" / "пол" = 0.5; "ikkita"/"две" = 2. Prices and amounts are plain numbers in the shop currency.',
    'product: the product as the user said it, spelled the way the shop catalog spells it (transliterate/translate to the catalog language if needed). Copy a catalog name only if the message identifies exactly that item. NEVER add model numbers, sizes or variants (like 25W, #100, 1kg) that the user did not say.',
    'Model names and numbers: keep EXACTLY what the user said. Never "correct" them to models you know — newer models exist that you have not heard of (iPhone 18, Galaxy S27, ...). Spoken numbers become digits as said ("o\'n sakkiz" = 18, "o\'n olti" = 16, "восемнадцать" = 18).',
    'Never invent customers, prices, quantities or products that were not said. Unknown values are null; qty null means 1.',
    'question: if something essential is missing or unclear (e.g. which product, or the amount), ask briefly IN THE LANGUAGE OF THE MESSAGE; for "unknown" — the reply described above (never null); otherwise null.',
    'language: ISO 639-1 code of the reply language (by the rule above).',
    'currency: ISO code of the currency the user named for prices/amounts (UZS for so\'m/sum/сум, USD for dollars, RUB for rubles, EUR, KZT), or null if no currency was named. Keep the numbers exactly as said — NEVER convert between currencies yourself, even if a rate is given.',
    'rate: if the user states an exchange rate ("dollar 12 mingdan", "kurs 12 100", "по 12 500"), the number of shop-currency units for 1 unit of the named currency (12000); otherwise null. A message that ONLY states a rate for the open request ("dollarni 12 mingdan hisobla") is a correction: revises=true, copy the open request in full (amounts still in the said currency) and set rate.',
    'Earlier messages of this chat may be given before the current one; after each you see your summary of it with "status": "open" (shown to the user, NOT saved yet), "saved", "cancelled" or "replaced".',
    '- References ("the products above", "o\'shani", "те же"): resolve them from the earlier messages and return the COMPLETE action (all items with their prices), not a question.',
    '- CORRECTIONS: if the current message corrects, completes or changes the latest "open" request — e.g. "X emas, Y", "X demadim, Y dedim", "Y dedim", "narxi 1800 bo\'lsin", "yana 2 ta qo\'sh", "Z ni olib tashla", "не X, а Y", "я сказал Y", "I said Y" — set revises=true and return THAT request IN FULL with only the correction applied: same action, every other item/person/customer/price/cost/qty/unit/amount copied unchanged. Never drop items the user did not ask to remove. A correction that only renames something ("16 emas, 18 Pro Max") changes ONLY that name and keeps its price, cost and qty.',
    '  If several requests are open, the correction belongs to the one that contains what is being corrected (usually the fuller one). If the latest open request was itself a misunderstood correction (it only repeats a name from an earlier open request), revise the EARLIER request and keep ITS action and all its items.',
    '- Otherwise (a new, separate action) revises=false.',
    'SEVERAL ACTIONS: one message may describe several separate actions — different people, or e.g. a lending plus a repayment, often one per line ("Anvarga 500 ming, Botirga 300 ming qarz berdim. Jamshiddan 200 ming qarz oldim. Kamol 400 ming qarzini berdi" = 4 actions). Put the FIRST action in the main fields and EVERY other action, in the order said, into also (same fields; a shared verb applies to each person: "Anvarga 500 ming, Botirga 300 ming qarz berdim" = two payment_out). Never ask the user to send them one by one and never merge different people into one action. One action → also = []. Exceptions that stay ONE action: one sale/receipt of several products (items), several new people with balances only ("customer" with people). A correction (revises=true) → also = [].',
    '',
    `Shop: ${h.shopName}. Currency: ${h.currency}.`,
    h.products.length ? `Catalog product names (sample): ${h.products.join(' | ')}` : 'Catalog: empty.',
    h.customers.length ? `Customer names: ${h.customers.join(' | ')}` : '',
  ].filter(Boolean).join('\n')
}

const str = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const numOrNull = (v: unknown, max = 1e12): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(/[\s,]/g, '')) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max ? n : null
}

/** Model javobini qat'iy shaklga keltiradi — noma'lum/yaroqsiz maydon null bo'ladi. `nested` — `also` elementi. */
export function sanitize(raw: unknown, nested = false): Extraction {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const action = KINDS.includes(o.action as Kind) ? (o.action as Kind) : 'unknown'
  const items = (Array.isArray(o.items) ? o.items : []).slice(0, 20).flatMap((it) => {
    const r = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
    const product = str(r.product)
    return product ? [{ product, qty: numOrNull(r.qty, 1e6), price: numOrNull(r.price), cost: numOrNull(r.cost), unit: str(r.unit, 20) }] : []
  })
  const people = (Array.isArray(o.people) ? o.people : []).slice(0, 30).flatMap((it) => {
    const r = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
    const name = str(r.name)
    return name ? [{ name, phone: str(r.phone, 40), owes: numOrNull(r.owes), owed: numOrNull(r.owed) }] : []
  })
  const method = ['cash', 'card', 'debt', 'transfer'].includes(o.method as string) ? (o.method as Extraction['method']) : null
  // Hisobot savoli: "report" amali (yoki noma'lum amal + mavzu) — matnli javob ("unknown"), raqamni server hisoblaydi.
  const topic = REPORT_TOPICS.includes(o.report as ReportTopic) ? (o.report as ReportTopic) : null
  const report = o.action === 'report' || (action === 'unknown' && topic) ? topic : null
  const language = str(o.language, 8)
  // Keyingi amallar: tuzatish ham, kurs ham, ichma-ich `also` ham emas; tushunilmagan bo'lagi tashlanadi.
  const also = nested || o.revises === true ? [] : (Array.isArray(o.also) ? o.also : []).slice(0, MAX_ACTIONS - 1)
    .map((x) => sanitize(x, true))
    .filter((x) => x.action !== 'unknown' || x.report)
    .map((x) => ({ ...x, language: x.language ?? language }))
  return {
    action: o.action === 'report' ? 'unknown' : action,
    customer: str(o.customer),
    items,
    people,
    amount: numOrNull(o.amount),
    method,
    paid: numOrNull(o.paid),
    category: str(o.category, 40),
    supplier: str(o.supplier),
    note: str(o.note, 300),
    language,
    currency: str(o.currency, 8)?.toUpperCase() ?? null,
    question: str(o.question, 300),
    revises: !nested && o.revises === true,
    rate: (() => { const r = numOrNull(o.rate); return r !== null && r > 0 && r <= 1e7 ? r : null })(),
    report,
    period: report && REPORT_PERIODS.includes(o.period as ReportPeriod) ? (o.period as ReportPeriod) : null,
    ...(nested ? {} : { also }),
  }
}

export function parseLoose(resp: unknown): unknown {
  if (resp && typeof resp === 'object') return resp
  if (typeof resp !== 'string') return null
  const m = resp.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

/** Matn → amal. JSON rejimi bajarilmasa (Workers AI kafolat bermaydi) — oddiy javobdan JSON qidiriladi. */
export async function extract(ai: AiRunner, text: string, hints: ShopHints, history: Turn[] = []): Promise<Extraction> {
  const messages = [
    { role: 'system', content: systemPrompt(hints) },
    ...history.map((t) => ({ role: t.role, content: t.text.slice(0, 1500) })),
    { role: 'user', content: text.slice(0, 1500) },
  ]
  let out: unknown
  try {
    out = await ai.run(LLM_MODEL, { messages, response_format: { type: 'json_schema', json_schema: SCHEMA }, max_tokens: 1500, temperature: 0.1 })
  } catch {
    out = await ai.run(LLM_MODEL, { messages, max_tokens: 1500, temperature: 0.1 })
  }
  return sanitize(parseLoose((out as { response?: unknown })?.response ?? out))
}
