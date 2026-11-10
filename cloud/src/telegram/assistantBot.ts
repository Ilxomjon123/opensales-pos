import type { Env } from '../env'
import type { ApplyOutcome, Draft } from '../shop/assistant'
import { defaultMembership, listMemberships, type MemberWithTenant } from '../registry'
import { runAssistant } from '../assistant/pipeline'
import { withFx } from '../assistant/fx'
import { syncBranchesOf } from '../catalog'
import { escapeHtml, tgCall } from './api'

// Bot orqali yordamchi: a'zo botga ovozli yoki oddiy xabar yuboradi → tahlil → tasdiqlash kartasi
// (✅ / ❌ / ✏️ ilovada). Tugma bosilganda qoralama oddiy op bilan yoziladi (o'sha tekshiruvlar,
// `ai_<id>` kaliti — ikki marta bosilsa ham bitta yozuv). Karta egasidan boshqa odam bosa olmaydi
// (qoralama uid bo'yicha topiladi).

export type Lang = 'uz' | 'ru'
const MAX_VOICE_SECONDS = 90
const MAX_VOICE_BYTES = 2_000_000

const T = {
  uz: {
    kind: { sale: '🧾 Sotuv', payment_in: "💵 Mijozdan to'lov", expense: '💸 Xarajat', receipt: '📦 Kirim (tovar keldi)', product: '🆕 Yangi tovar', customer: '👥 Yangi mijoz', unknown: '🤔 Tushunmadim' },
    owes: 'qarzi', owed: 'haqi', noBalance: 'saldosiz', createdCustomers: "{n} ta mijoz qo'shildi",
    created: "{n} ta tovar qo'shildi", startStock: 'qoldiq', cost: 'tannarx',
    customer: 'Mijoz', walkIn: "Yo'l-yo'lakay xaridor", total: 'Jami', amount: 'Summa', category: 'Toifa', note: 'Izoh', supplier: "Ta'minotchi", paidNow: "Hozir to'landi",
    method: { cash: 'naqd', card: 'karta', debt: 'qarzga', transfer: "o'tkazma" },
    pick: 'tanlash kerak', confirm: '✅ Tasdiqlash', cancel: '❌ Bekor', edit: '✏️ Ilovada ochish', fix: '✏️ Ilovada tuzatish',
    convertSave: "✅ {shop}ga o'tkazib saqlash", fxLine: '💱 1 {cur} = {rate} {shop} · {src}', fxSaved: 'oxirgi kursingiz', fxCbu: 'MB kursi {date}',
    replaced: '↪️ Yangilandi — pastdagi kartaga qarang',
    newCustomerTag: "yangi mijoz, saqlashda qo'shiladi",
    expired: "⌛ Muddati o'tgan — qaytadan ayting",
    saved: '✅ Saqlandi', cancelled: '❌ Bekor qilindi', notMember: "Bu amal uchun kassaga ulangan bo'lishingiz kerak.", open: '🧾 Kassani ochish',
    tooLong: `Ovozli xabar juda uzun (${MAX_VOICE_SECONDS} soniyagacha).`, receipt: 'Chek', debt: 'qarz',
    unknownHint: "Masalan: «Bahromga 2 ta Samsung zaryadka qarzga», «Ali 50 ming to'ladi», «Ijaraga 2 mln berdim».",
    issue: {
      unknown: 'Amal aniqlanmadi', notAllowed: "Bu amal uchun huquqingiz yo'q", noItems: "Tovar aytilmadi",
      pickProduct: '«{name}» — qaysi tovar? Ilovada tanlang', productNotFound: '«{name}» bazada topilmadi',
      insufficientStock: '{name}: qoldiq {stock} {unit}', costMissing: '{name}: kirim narxi aytilmadi',
      pickCustomer: '«{name}» — qaysi mijoz? Ilovada tanlang', customerNotFound: '«{name}» mijozi topilmadi',
      customerNeeded: 'Qaysi mijoz to\'laganini ayting', debtNeedsCustomer: "Qarzga sotish uchun mijoz kerak",
      shiftNotOpen: 'Avval kassada smena oching', amountMissing: 'Summa aytilmadi',
      currencyMismatch: "Narx {said}da aytildi, do'kon valyutasi {shop} — ilovada tuzating",
      currencyMismatchFx: "Narx {said}da aytildi — saqlashda {shop}ga o'tkaziladi (kursni ilovada o'zgartirish mumkin)",
      priceMissing: '{name}: sotish narxi aytilmadi',
      customerExists: '«{name}» mijozi allaqachon bor', noPeople: 'Mijoz aytilmadi', productExists: '«{name}» bazada allaqachon bor', nameMissing: 'Tovar nomi aytilmadi',
    } as Record<string, string>,
    err: {
      'cloud.ai.errors.quota': "Bugungi AI limiti tugadi. Ertaga yoki ilovada qo'lda kiriting.",
      'cloud.ai.errors.disabled': "Bu do'kon uchun AI yordamchi o'chirilgan. Amallarni ilovada qo'lda kiriting.",
      'cloud.ai.errors.stt': 'Ovozni tanib bo\'lmadi. Qayta yuboring yoki matn yozing.',
      'cloud.ai.errors.emptySpeech': 'Ovozda gap eshitilmadi.',
      'cloud.ai.errors.audioTooLong': `Ovozli xabar juda uzun (${MAX_VOICE_SECONDS} soniyagacha).`,
      'cloud.ai.errors.llm': 'Tahlil qilib bo\'lmadi. Birozdan keyin qayta urinib ko\'ring.',
      'cloud.ai.errors.unavailable': 'Yordamchi hozircha o\'chiq.',
      'cloud.ai.errors.draftGone': 'Bu qoralama eskirgan. Qaytadan yuboring.',
      'cloud.ai.errors.draftCancelled': 'Bu qoralama bekor qilingan.',
      'cloud.ai.errors.notReady': 'Avval kamchiliklarni ilovada tuzating.',
      'cloud.errors.subscriptionExpired': 'Obuna muddati tugagan.',
      'cloud.errors.shiftNotOpen': 'Avval kassada smena oching.',
      'cloud.errors.insufficientStock': 'Qoldiq yetarli emas.',
      'cloud.errors.forbidden': "Bu amal uchun huquqingiz yo'q.",
      'cloud.errors.memberRevoked': "Kirishingiz o'chirilgan.",
      'sales.noDebtForWalkIn': "Yo'l-yo'lakay xaridorga qarzga sotib bo'lmaydi.",
      'cloud.ai.errors.productExists': 'Bunday tovar bazada allaqachon bor.',
      'cloud.ai.errors.customerExists': 'Bunday mijoz bazada allaqachon bor.',
    } as Record<string, string>,
    errFallback: "Saqlab bo'lmadi — ilovada ochib ko'ring.",
  },
  ru: {
    kind: { sale: '🧾 Продажа', payment_in: '💵 Оплата от клиента', expense: '💸 Расход', receipt: '📦 Приход товара', product: '🆕 Новый товар', customer: '👥 Новый клиент', unknown: '🤔 Не понял' },
    owes: 'долг', owed: 'мы должны', noBalance: 'без сальдо', createdCustomers: 'Добавлено клиентов: {n}',
    created: 'Добавлено товаров: {n}', startStock: 'остаток', cost: 'себест.',
    customer: 'Клиент', walkIn: 'Случайный покупатель', total: 'Итого', amount: 'Сумма', category: 'Категория', note: 'Заметка', supplier: 'Поставщик', paidNow: 'Оплачено сейчас',
    method: { cash: 'наличные', card: 'карта', debt: 'в долг', transfer: 'перевод' },
    pick: 'нужно выбрать', confirm: '✅ Подтвердить', cancel: '❌ Отмена', edit: '✏️ Открыть в приложении', fix: '✏️ Исправить в приложении',
    convertSave: '✅ Пересчитать в {shop} и сохранить', fxLine: '💱 1 {cur} = {rate} {shop} · {src}', fxSaved: 'ваш последний курс', fxCbu: 'курс ЦБ {date}',
    replaced: '↪️ Обновлено — смотрите карточку ниже',
    newCustomerTag: 'новый клиент, будет добавлен при сохранении',
    expired: '⌛ Истекло — скажите заново',
    saved: '✅ Сохранено', cancelled: '❌ Отменено', notMember: 'Для этого нужно быть подключённым к кассе.', open: '🧾 Открыть кассу',
    tooLong: `Голосовое слишком длинное (до ${MAX_VOICE_SECONDS} секунд).`, receipt: 'Чек', debt: 'долг',
    unknownHint: 'Например: «Бахрому 2 зарядки Samsung в долг», «Али оплатил 50 тысяч», «Отдал 2 млн за аренду».',
    issue: {
      unknown: 'Действие не распознано', notAllowed: 'Нет прав на это действие', noItems: 'Товар не назван',
      pickProduct: '«{name}» — какой товар? Выберите в приложении', productNotFound: '«{name}» не найден в базе',
      insufficientStock: '{name}: остаток {stock} {unit}', costMissing: '{name}: не названа цена прихода',
      pickCustomer: '«{name}» — какой клиент? Выберите в приложении', customerNotFound: 'Клиент «{name}» не найден',
      customerNeeded: 'Назовите, какой клиент оплатил', debtNeedsCustomer: 'Для продажи в долг нужен клиент',
      shiftNotOpen: 'Сначала откройте смену в кассе', amountMissing: 'Сумма не названа',
      currencyMismatch: 'Цена названа в {said}, валюта магазина — {shop}. Исправьте в приложении',
      currencyMismatchFx: 'Цена названа в {said} — при сохранении пересчитается в {shop} (курс можно изменить в приложении)',
      priceMissing: '{name}: не названа цена продажи',
      customerExists: 'Клиент «{name}» уже есть', noPeople: 'Клиент не назван', productExists: '«{name}» уже есть в базе', nameMissing: 'Не названо название товара',
    } as Record<string, string>,
    err: {
      'cloud.ai.errors.quota': 'Дневной лимит AI исчерпан. Завтра или вручную в приложении.',
      'cloud.ai.errors.disabled': 'AI-помощник для этого магазина отключён. Вносите операции в приложении.',
      'cloud.ai.errors.stt': 'Не удалось распознать голос. Отправьте ещё раз или напишите текстом.',
      'cloud.ai.errors.emptySpeech': 'В голосовом не слышно речи.',
      'cloud.ai.errors.audioTooLong': `Голосовое слишком длинное (до ${MAX_VOICE_SECONDS} секунд).`,
      'cloud.ai.errors.llm': 'Не удалось разобрать. Попробуйте чуть позже.',
      'cloud.ai.errors.unavailable': 'Помощник сейчас выключен.',
      'cloud.ai.errors.draftGone': 'Черновик устарел. Отправьте заново.',
      'cloud.ai.errors.draftCancelled': 'Черновик отменён.',
      'cloud.ai.errors.notReady': 'Сначала исправьте недочёты в приложении.',
      'cloud.errors.subscriptionExpired': 'Подписка истекла.',
      'cloud.errors.shiftNotOpen': 'Сначала откройте смену в кассе.',
      'cloud.errors.insufficientStock': 'Недостаточно остатка.',
      'cloud.errors.forbidden': 'Нет прав на это действие.',
      'cloud.errors.memberRevoked': 'Ваш доступ отключён.',
      'sales.noDebtForWalkIn': 'Случайному покупателю нельзя в долг.',
      'cloud.ai.errors.productExists': 'Такой товар уже есть в базе.',
      'cloud.ai.errors.customerExists': 'Такой клиент уже есть.',
    } as Record<string, string>,
    errFallback: 'Не удалось сохранить — откройте в приложении.',
  },
} as const

const fmt = (n: number) => {
  const r = Math.round(n * 100) / 100
  const [i, f] = String(Math.abs(r)).split('.')
  return (r < 0 ? '−' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (f ? ',' + f : '')
}
/** Summa belgilangan valyutada: $1 000, 1 000 so'm, 1 000 ₽ (kod bo'lmasa — do'kon belgisi). */
function fmtIn(n: number, code: string | null, shopSymbol: string): string {
  const v = fmt(n)
  switch (code) {
    case 'USD': return '$' + v
    case 'EUR': return '€' + v
    case 'RUB': return v + ' ₽'
    case 'KZT': return v + ' ₸'
    case 'UZS': return v + " so'm"
    default: return v + ' ' + escapeHtml(shopSymbol)
  }
}
const CUR_SIGN: Record<string, string> = { USD: '$', EUR: '€', RUB: '₽', KZT: '₸', UZS: "so'm" }
/** Kurs tugma ma'lumotida (callback_data ≤ 64 bayt): 4 xonagacha kasr. */
const rateStr = (r: number) => String(Math.round(r * 10_000) / 10_000)
const fill = (s: string, p: Record<string, unknown> = {}) => s.replace(/\{(\w+)\}/g, (_, k) => escapeHtml(String(p[k] ?? '')))

function appUrl(env: Env, query: string) {
  return env.APP_URL.replace(/\/+$/, '') + '/' + query
}

/** Qoralama → karta matni (HTML). */
/** Amal emas, savol (tushunilmadi yoki tovar aytilmadi) — karta tugmalarisiz, faqat javob matni. */
export const chatOnly = (d: Draft) => d.kind === 'unknown' || ((d.kind === 'sale' || d.kind === 'receipt' || d.kind === 'product') && d.items.length === 0) || (d.kind === 'customer' && !(d.people ?? []).length)

export function renderDraft(d: Draft, l: Lang, opts: { transcript?: boolean } = {}): string {
  const t = T[l]
  if (chatOnly(d) && d.status === 'new') return `${escapeHtml(d.question ?? t.unknownHint)}\n\n<i>🗣 «${escapeHtml(d.transcript.slice(0, 300))}»</i>`
  // Narx boshqa valyutada aytilgan bo'lsa (hali tuzatilmagan) — summalar O'SHA valyutada ko'rsatiladi.
  const money = (n: number) => fmtIn(n, d.spokenCurrency && d.issues.some((i) => i.code === 'currencyMismatch') ? d.spokenCurrency : null, d.currency)
  const lines: string[] = [`<b>${t.kind[d.kind]}</b>`]
  if (d.kind === 'sale' || d.kind === 'payment_in') {
    const who = d.customerId && d.customerId !== d.walkInId ? d.customerName : d.customerQuery ? `❓ «${d.customerQuery}»` : t.walkIn
    if (d.newCustomer && !d.customerId) lines.push(`${t.customer}: <b>${escapeHtml(d.newCustomer)}</b> · 🆕 ${t.newCustomerTag}`)
    else lines.push(`${t.customer}: <b>${escapeHtml(who ?? t.walkIn)}</b>`)
  }
  if (d.kind === 'receipt' && d.supplier) lines.push(`${t.supplier}: <b>${escapeHtml(d.supplier)}</b>`)
  if (d.kind === 'sale' || d.kind === 'receipt') {
    for (const it of d.items) {
      if (it.productId) lines.push(`• ${escapeHtml(it.name ?? '')} × ${fmt(it.qty)}${it.unit ? ' ' + escapeHtml(it.unit) : ''}${it.price !== null ? ` = ${money(it.qty * it.price)}` : ''}`)
      else lines.push(`• ❓ «${escapeHtml(it.query)}» — ${t.pick}`)
    }
    const m = d.kind === 'sale' ? ` · ${t.method[d.method]}` : ''
    lines.push(`<b>${t.total}: ${money(d.total)}</b>${m}`)
    if (d.kind === 'sale' && d.paid !== null && d.paid < d.total) lines.push(`${t.paidNow}: ${money(d.paid)}`)
  }
  if (d.kind === 'customer') {
    for (const p of d.people ?? []) {
      const bal = p.kind === 'debt' ? `${t.owes} ${money(p.amount ?? 0)}` : p.kind === 'credit' ? `${t.owed} ${money(p.amount ?? 0)}` : t.noBalance
      lines.push(`• <b>${escapeHtml(p.name)}</b>${p.phone ? ` · ${escapeHtml(p.phone)}` : ''} — ${bal}`)
    }
  }
  if (d.kind === 'product') {
    for (const it of d.items) {
      lines.push(`• <b>${escapeHtml(it.name ?? it.query)}</b> — ${it.price ? money(it.price) : '—'}${it.cost ? ` · ${t.cost} ${money(it.cost)}` : ''}${it.qty ? ` · ${t.startStock} ${fmt(it.qty)} ${escapeHtml(it.unit ?? '')}` : ''}`)
    }
  }
  if (d.kind === 'payment_in' || d.kind === 'expense') {
    lines.push(`<b>${t.amount}: ${d.amount ? money(d.amount) : '—'}</b>${d.kind === 'payment_in' ? ` · ${t.method[d.method]}` : ''}`)
    if (d.kind === 'expense' && d.category) lines.push(`${t.category}: ${escapeHtml(d.category)}`)
  }
  if (d.note && d.kind !== 'unknown') lines.push(`${t.note}: ${escapeHtml(d.note)}`)
  const issues = d.issues.filter((i) => !(d.kind === 'unknown' && i.code === 'unknown'))
  const fx = d.status === 'new' ? d.fx : null
  if (issues.length) lines.push('', ...issues.map((i) => `⚠️ ${fill(t.issue[i.code === 'currencyMismatch' && fx ? 'currencyMismatchFx' : i.code] ?? i.code, i.params)}`))
  if (fx) {
    const src = fx.source === 'saved' ? t.fxSaved : t.fxCbu.replace('{date}', fx.date ?? '')
    lines.push(fill(t.fxLine, { cur: CUR_SIGN[fx.from] ?? fx.from, rate: fmt(fx.rate), shop: d.currency, src: src.trim() }))
  }
  if (d.kind === 'unknown') lines.push('', escapeHtml(d.question ?? t.unknownHint))
  else if (d.question && !d.ready) lines.push(`💬 ${escapeHtml(d.question)}`)
  // Ilova chatida foydalanuvchi xabari tepada turibdi — karta transkriptni takrorlamaydi.
  if (opts.transcript !== false) lines.push('', `<i>🗣 «${escapeHtml(d.transcript.slice(0, 300))}»</i>`)
  return lines.join('\n')
}

/** Ilova chati uchun karta: botdagi bilan bir xil matn, holat bilan (saqlandi / bekor / yangilandi / muddati o'tgan). */
export function draftCardHtml(d: Draft, l: Lang, expired = false): string {
  const t = T[l]
  const body = renderDraft(d, l, { transcript: false }).replace(/\n+$/, '')
  if (d.status === 'applied') return body + resultLine(d, l)
  if (d.status === 'cancelled') return `${body}\n\n<b>${d.replacedBy ? t.replaced : t.cancelled}</b>`
  if (expired) return `${body}\n\n<i>${t.expired}</i>`
  return body
}

function resultLine(d: Draft, l: Lang): string {
  const t = T[l]
  const r = d.result ?? {}
  if (d.kind === 'product') return `\n\n<b>${t.saved}</b> · ${t.created.replace('{n}', String(r.count ?? d.items.length))}`
  if (d.kind === 'customer') return `\n\n<b>${t.saved}</b> · ${t.createdCustomers.replace('{n}', String(r.count ?? (d.people ?? []).length))}`
  const no = r.receiptNumber ? ` · ${d.kind === 'sale' ? t.receipt + ' ' : ''}#${escapeHtml(String(r.receiptNumber))}` : ''
  const debt = d.kind === 'sale' && Number(r.debt) > 0 ? ` · ${t.debt} ${fmt(Number(r.debt))} ${escapeHtml(d.currency)}` : ''
  return `\n\n<b>${t.saved}</b>${no}${debt}`
}

function keyboard(env: Env, d: Draft, l: Lang) {
  const t = T[l]
  const open = { text: d.ready ? t.edit : t.fix, web_app: { url: appUrl(env, `?draft=${d.id}`) } }
  if (chatOnly(d)) return undefined
  if (d.ready) return { inline_keyboard: [[{ text: t.confirm, callback_data: `a:${d.id}` }, { text: t.cancel, callback_data: `x:${d.id}` }], [open]] }
  if (d.fx && d.status === 'new' && d.issues.length && d.issues.every((i) => i.code === 'currencyMismatch')) {
    const save = { text: t.convertSave.replace('{shop}', d.currency), callback_data: `r:${d.id}:${rateStr(d.fx.rate)}` }
    return { inline_keyboard: [[save], [{ ...open, text: t.fix }, { text: t.cancel, callback_data: `x:${d.id}` }]] }
  }
  return { inline_keyboard: [[open], [{ text: t.cancel, callback_data: `x:${d.id}` }]] }
}

const langOf = (code: string | undefined, d?: Draft | null): Lang => (code === 'ru' || (!code && d?.language === 'ru') ? 'ru' : 'uz')

type Msg = {
  message_id?: number
  chat: { id: number }
  from: { id: number; language_code?: string }
  text?: string
  voice?: { file_id: string; duration: number; file_size?: number; mime_type?: string }
  audio?: { file_id: string; duration: number; file_size?: number; mime_type?: string }
}

async function download(env: Env, fileId: string): Promise<Uint8Array | null> {
  const f = await tgCall<{ file_path?: string; file_size?: number }>(env, 'getFile', { file_id: fileId })
  if (!f.ok || !f.result.file_path || (f.result.file_size ?? 0) > MAX_VOICE_BYTES) return null
  const base = env.TG_API_BASE || 'https://api.telegram.org'
  const res = await fetch(`${base}/file/bot${env.BOT_TOKEN}/${f.result.file_path}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null)
  if (!res?.ok) return null
  const bytes = new Uint8Array(await res.arrayBuffer())
  return bytes.byteLength > 0 && bytes.byteLength <= MAX_VOICE_BYTES ? bytes : null
}

/** Botga kelgan oddiy matn yoki ovoz (buyruq emas). true — xabar shu yerda hal qilindi. */
export async function botAssistant(env: Env, msg: Msg): Promise<boolean> {
  const l = langOf(msg.from.language_code)
  const t = T[l]
  const chatId = msg.chat.id
  // Javob foydalanuvchining o'sha xabariga reply — bir nechta ovoz ketma-ket yuborilsa ham qaysi biriga javob ekani ko'rinadi.
  const reply = msg.message_id ? { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } } : {}
  const send = (text: string, extra: Record<string, unknown> = {}) =>
    tgCall(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...reply, ...extra })
  // Bir nechta do'kon: ilovada (yoki /dokon bilan) tanlangan do'kon; kartada do'kon nomi.
  const member = await defaultMembership(env.DB, msg.from.id)
  if (!member || !member.active) {
    await send(t.notMember, { reply_markup: { inline_keyboard: [[{ text: t.open, web_app: { url: appUrl(env, '') } }]] } })
    return true
  }
  const voice = msg.voice ?? msg.audio
  if (voice && voice.duration > MAX_VOICE_SECONDS) { await send(t.tooLong); return true }
  await tgCall(env, 'sendChatAction', { chat_id: chatId, action: 'typing' })
  let input: { text?: string; audio?: Uint8Array; mime?: string }
  if (voice) {
    const bytes = await download(env, voice.file_id)
    if (!bytes) { await send(t.err['cloud.ai.errors.stt']); return true }
    input = { audio: bytes, mime: voice.mime_type ?? 'audio/ogg' }
  } else {
    input = { text: msg.text ?? '' }
  }
  const r = await runAssistant(env, member.tenant_id, { uid: member.uid, role: member.role, name: member.name }, input, voice ? 'bot_voice' : 'bot_text', null, l)
  if (!r.ok) { await send(t.err[r.code] ?? t.errFallback); return true }
  const dl = langOf(msg.from.language_code, r.draft)
  const actor = { uid: member.uid, role: member.role, name: member.name }
  const draft = await withFx(env, member.tenant_id, r.draft)
  const tag = await shopTag(env, member)
  const sent = await tgCall<{ message_id: number }>(env, 'sendMessage', {
    chat_id: chatId, text: tag + renderDraft(draft, dl), parse_mode: 'HTML', disable_web_page_preview: true, ...reply, reply_markup: keyboard(env, draft, dl),
  })
  if (sent.ok && sent.result?.message_id && !chatOnly(draft)) {
    await env.SHOP.getByName(member.tenant_id).assistantSetCard(actor, draft.id, chatId, sent.result.message_id)
  }
  if (draft.replaces) await markReplaced(env, member.tenant_id, actor, draft.replaces, dl, tag)
  return true
}

/** Odamning bir nechta faol do'koni bo'lsa — karta tepasida qaysi do'konga yozilishi. */
async function shopTag(env: Env, m: MemberWithTenant): Promise<string> {
  const active = (await listMemberships(env.DB, m.uid)).filter((x) => x.active)
  return active.length > 1 ? `🏪 <b>${escapeHtml(m.tenant.name)}</b>\n` : ''
}

/**
 * Karta tugmasi: qoralama qaysi do'konda ekanini topamiz — avval tanlangan do'kon, keyin qolgan faol
 * a'zoliklar (karta yuborilgandan keyin do'kon almashtirilgan bo'lishi mumkin).
 */
async function draftOwner(env: Env, uid: number, draftId: string): Promise<MemberWithTenant | null> {
  const first = await defaultMembership(env.DB, uid)
  const all = (await listMemberships(env.DB, uid)).filter((x) => x.active)
  const order = first && first.active ? [first, ...all.filter((x) => x.tenant_id !== first.tenant_id)] : all
  for (const m of order) {
    const d = await env.SHOP.getByName(m.tenant_id).assistantGet({ uid: m.uid, role: m.role, name: m.name }, draftId)
    if (d) return m
  }
  return order[0] ?? null
}

/** Tuzatish bilan almashtirilgan eski karta: tugmalarsiz, "yangilandi" belgisi bilan (eskisini tasdiqlab yubormaslik uchun). */
export async function markReplaced(env: Env, tenantId: string, actor: { uid: number; role: 'owner' | 'cashier'; name: string }, oldId: string, l: Lang = 'uz', tag = '') {
  const old = (await env.SHOP.getByName(tenantId).assistantGet(actor, oldId)) as Draft | null
  if (!old?.card) return
  await tgCall(env, 'editMessageText', {
    chat_id: old.card.chat, message_id: old.card.msg, text: `${tag}${renderDraft(old, l)}\n\n<b>${T[l].replaced}</b>`, parse_mode: 'HTML', disable_web_page_preview: true,
  })
}

type Callback = { id: string; from: { id: number; language_code?: string }; data?: string; message?: { chat: { id: number }; message_id: number } }

/** ✅ / ❌ tugmalari. Karta faqat qoralama egasining tugmasi bilan o'zgaradi. */
export async function botAssistantCallback(env: Env, cb: Callback): Promise<void> {
  const l = langOf(cb.from.language_code)
  const t = T[l]
  const answer = (text?: string, alert = false) => tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert })
  const m = /^([axr]):([a-f0-9]{16})(?::(\d{1,9}(?:\.\d{1,4})?))?$/.exec(cb.data ?? '')
  if (!m || !cb.message) { await answer(); return }
  const member = await draftOwner(env, cb.from.id, m[2])
  if (!member || !member.active) { await answer(t.notMember, true); return }
  const shop = env.SHOP.getByName(member.tenant_id)
  const actor = { uid: member.uid, role: member.role, name: member.name }
  const tag = await shopTag(env, member)
  const edit = (d: Draft, tail = '', withKeyboard = false) => tgCall(env, 'editMessageText', {
    chat_id: cb.message!.chat.id, message_id: cb.message!.message_id, text: tag + renderDraft(d, l) + tail, parse_mode: 'HTML',
    disable_web_page_preview: true, ...(withKeyboard ? { reply_markup: keyboard(env, d, l) } : {}),
  })
  if (m[1] === 'x') {
    const d = (await shop.assistantCancel(actor, m[2])) as Draft | null
    if (!d) { await answer(t.err['cloud.ai.errors.draftGone'], true); return }
    await answer(t.cancelled)
    await edit(d, d.status === 'applied' ? resultLine(d, l) : `\n\n<b>${t.cancelled}</b>`)
    return
  }
  // r: valyuta bilan aytilgan narxlar kartadagi kurs bo'yicha o'tkaziladi va o'sha zahoti saqlanadi.
  const rate = m[1] === 'r' ? Number(m[3]) : 0
  if (m[1] === 'r' && !(rate > 0)) { await answer(); return }
  const r = (await shop.assistantApply(actor, m[2], m[1] === 'r' ? { rate } : null)) as ApplyOutcome
  if (r.ok) {
    await answer(t.saved)
    await edit(r.draft, resultLine(r.draft, l))
    // Yordamchi asosiy do'konda tovar yaratgan / narx o'zgartirgan bo'lishi mumkin — filiallarga.
    await syncBranchesOf(env, member.tenant_id).catch(() => undefined)
    return
  }
  const params = r.error.params ?? {}
  const msg = r.error.code === 'cloud.errors.insufficientStock' && params.name
    ? `${String(params.name)}: ${t.issue.insufficientStock.replace('{name}: ', '').replace('{stock}', String(params.stock)).replace('{unit}', String(params.unit ?? ''))}`
    : t.err[r.error.code] ?? t.errFallback
  await answer(msg, true)
  if (r.draft) await edit(r.draft, '', true)
}
