import type { Env } from '../env'
import { isChatOnly, type ApplyOutcome, type Draft, type DraftEdits, type GroupApply, type GroupRow } from '../shop/assistant'
import { EXPENSE_CATEGORIES } from '../assistant/ai'
import { defaultMembership, listMemberships, type MemberWithTenant } from '../registry'
import { runAssistant } from '../assistant/pipeline'
import { withFx } from '../assistant/fx'
import { syncBranchesOf } from '../catalog'
import { escapeHtml, tgCall, type TgResult } from './api'
import { draftWidgetCaption, draftWidgetData, draftWidgetHtml, METHOD_OF, type IssueText, type MethodCode } from './draftWidget'
import type { WidgetQuery } from './funnelWidget'

// Bot orqali yordamchi: a'zo botga ovozli yoki oddiy xabar yuboradi → tahlil → tasdiqlash kartasi
// (✅ / ❌ / ✏️ ilovada). Tugma bosilganda qoralama oddiy op bilan yoziladi (o'sha tekshiruvlar,
// `ai_<id>` kaliti — ikki marta bosilsa ham bitta yozuv). Karta egasidan boshqa odam bosa olmaydi
// (qoralama uid bo'yicha topiladi).
// 2026-11-12: tasdiqlash kartasi — HTML widget (draftWidget.ts): xabarning hamma amallari bitta kartada, tahrir widget
// ichida (`y…` so'rovlari), "✅ Tasdiqlash / ❌ Bekor" widget ostidagi tugmalarda (`A:`/`X:` + guruh id).
// sendWidget yiqilsa — avvalgi matnli kartalar (`a:`/`x:`/`r:` tugmalari, eski kartalar uchun ham ishlaydi).

export type Lang = 'uz' | 'ru'
const MAX_VOICE_SECONDS = 90
const MAX_VOICE_BYTES = 2_000_000

const T = {
  uz: {
    kind: { sale: '🧾 Sotuv', payment_in: "💵 Mijozdan to'lov", payment_out: '📤 Mijozga qarz berildi', expense: '💸 Xarajat', receipt: '📦 Kirim (tovar keldi)', product: '🆕 Yangi tovar', customer: '👥 Yangi mijoz', unknown: '🤔 Tushunmadim' },
    owes: 'qarzi', owed: 'haqi', noBalance: 'saldosiz', createdCustomers: "{n} ta mijoz qo'shildi",
    created: "{n} ta tovar qo'shildi", startStock: 'qoldiq', cost: 'tannarx',
    customer: 'Mijoz', walkIn: "Yo'l-yo'lakay xaridor", total: 'Jami', amount: 'Summa', category: 'Toifa', note: 'Izoh', supplier: "Ta'minotchi", paidNow: "Hozir to'landi",
    method: { cash: 'naqd', card: 'karta', debt: 'qarzga', transfer: "o'tkazma" },
    pick: 'tanlash kerak', confirm: '✅ Tasdiqlash', confirmAll: '✅ Hammasini tasdiqlash', fixFirst: 'Avval tuzating (qatorni bosing):', cancel: '❌ Bekor', edit: '✏️ Ilovada ochish', fix: '✏️ Ilovada tuzatish',
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
      customerNeeded: 'Qaysi mijoz to\'laganini ayting', customerNeededOut: 'Kimga qarz berilganini ayting', debtNeedsCustomer: "Qarzga sotish uchun mijoz kerak",
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
    kind: { sale: '🧾 Продажа', payment_in: '💵 Оплата от клиента', payment_out: '📤 Выдано в долг клиенту', expense: '💸 Расход', receipt: '📦 Приход товара', product: '🆕 Новый товар', customer: '👥 Новый клиент', unknown: '🤔 Не понял' },
    owes: 'долг', owed: 'мы должны', noBalance: 'без сальдо', createdCustomers: 'Добавлено клиентов: {n}',
    created: 'Добавлено товаров: {n}', startStock: 'остаток', cost: 'себест.',
    customer: 'Клиент', walkIn: 'Случайный покупатель', total: 'Итого', amount: 'Сумма', category: 'Категория', note: 'Заметка', supplier: 'Поставщик', paidNow: 'Оплачено сейчас',
    method: { cash: 'наличные', card: 'карта', debt: 'в долг', transfer: 'перевод' },
    pick: 'нужно выбрать', confirm: '✅ Подтвердить', confirmAll: '✅ Подтвердить все', fixFirst: 'Сначала исправьте (нажмите на строку):', cancel: '❌ Отмена', edit: '✏️ Открыть в приложении', fix: '✏️ Исправить в приложении',
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
      customerNeeded: 'Назовите, какой клиент оплатил', customerNeededOut: 'Назовите, кому выдан долг', debtNeedsCustomer: 'Для продажи в долг нужен клиент',
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
export const chatOnly = isChatOnly

export function renderDraft(d: Draft, l: Lang, opts: { transcript?: boolean } = {}): string {
  const t = T[l]
  // Bitta xabarning keyingi amali (partOf) — transkript birinchi kartada bor, takrorlanmaydi.
  const said = opts.transcript ?? !d.partOf
  const quote = `<i>🗣 «${escapeHtml(d.transcript.slice(0, 300))}»</i>`
  if (chatOnly(d) && d.status === 'new') return said ? `${escapeHtml(d.question ?? t.unknownHint)}\n\n${quote}` : escapeHtml(d.question ?? t.unknownHint)
  // Narx boshqa valyutada aytilgan bo'lsa (hali tuzatilmagan) — summalar O'SHA valyutada ko'rsatiladi.
  const money = (n: number) => fmtIn(n, d.spokenCurrency && d.issues.some((i) => i.code === 'currencyMismatch') ? d.spokenCurrency : null, d.currency)
  const lines: string[] = [`<b>${t.kind[d.kind]}</b>`]
  if (d.kind === 'sale' || d.kind === 'payment_in' || d.kind === 'payment_out') {
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
  if (d.kind === 'payment_in' || d.kind === 'payment_out' || d.kind === 'expense') {
    lines.push(`<b>${t.amount}: ${d.amount ? money(d.amount) : '—'}</b>${d.kind !== 'expense' ? ` · ${t.method[d.method]}` : ''}`)
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
  if (said) lines.push('', quote)
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
  const tag = await shopTag(env, member)
  // Amallar — bitta widget karta (guruh id = birinchi qoralama), javob/savollar — oddiy xabar. Widget yuborilmasa —
  // avvalgidek har amalga matnli karta (o'z ✅/❌ bilan; transkript faqat birinchisida — renderDraft `partOf` ni biladi).
  const all = [r.draft, ...r.more]
  const acts = all.filter((d) => !chatOnly(d))
  let texts = all.filter(chatOnly)
  if (acts.length) {
    const sent = await sendDraftWidget(env, chatId, member, r.draft.id, acts, dl, tag, reply)
    if (sent.ok && sent.result?.message_id) {
      for (const d of acts) await env.SHOP.getByName(member.tenant_id).assistantSetCard(actor, d.id, chatId, sent.result.message_id, true)
    } else {
      console.warn('sendWidget:', sent.ok ? 'no message' : `${sent.status} ${sent.description}`)
      texts = all
    }
  }
  for (const d of texts) {
    const draft = await withFx(env, member.tenant_id, d)
    const sent = await tgCall<{ message_id: number }>(env, 'sendMessage', {
      chat_id: chatId, text: tag + renderDraft(draft, dl), parse_mode: 'HTML', disable_web_page_preview: true, ...reply, reply_markup: keyboard(env, draft, dl),
    })
    if (sent.ok && sent.result?.message_id && !chatOnly(draft)) {
      await env.SHOP.getByName(member.tenant_id).assistantSetCard(actor, draft.id, chatId, sent.result.message_id)
    }
  }
  if (r.draft.replaces) await markReplaced(env, member.tenant_id, actor, r.draft.replaces, dl, tag)
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
  if (old.card.w) { await refreshDraftWidget(env, tenantId, actor, old.partOf ?? old.id, old.card.chat, old.card.msg, l); return }
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
  const m = /^([axrAX]):([a-f0-9]{16})(?::(\d{1,9}(?:\.\d{1,4})?))?$/.exec(cb.data ?? '')
  if (!m || !cb.message) { await answer(); return }
  const member = await draftOwner(env, cb.from.id, m[2])
  if (!member || !member.active) { await answer(t.notMember, true); return }
  const shop = env.SHOP.getByName(member.tenant_id)
  const actor = { uid: member.uid, role: member.role, name: member.name }
  const tag = await shopTag(env, member)
  // Widget karta tugmalari: butun guruh (xabarning hamma amallari).
  if (m[1] === 'A' || m[1] === 'X') {
    const g = m[2]
    const where = { chat: cb.message.chat.id, msg: cb.message.message_id }
    if (m[1] === 'X') {
      await shop.assistantCancelGroup(actor, g)
      await answer(t.cancelled)
      await refreshDraftWidget(env, member.tenant_id, actor, g, where.chat, where.msg, l)
      return
    }
    const res = (await shop.assistantApplyGroup(actor, g)) as GroupApply | null
    if (!res) { await answer(t.notMember, true); return }
    if (!res.ok) {
      const issue = issueText(l)
      const lines = res.notReady.slice(0, 3).map((x) => `${x.index + 1}. ${x.draft.issues.map((i) => issue(i, x.draft)).find(Boolean) ?? ''}`)
      await answer(`${t.fixFirst}\n${lines.join('\n')}`.slice(0, 199), true)
      await refreshDraftWidget(env, member.tenant_id, actor, g, where.chat, where.msg, l)
      return
    }
    const errors = Object.fromEntries(res.results.flatMap((x) => (x.error ? [[x.id, errText(l, x.error.code, x.error.params)]] : [])))
    const failed = Object.values(errors)
    await answer(failed.length ? failed[0].slice(0, 199) : t.saved, failed.length > 0)
    await refreshDraftWidget(env, member.tenant_id, actor, g, where.chat, where.msg, l, errors)
    // Yordamchi asosiy do'konda tovar yaratgan / narx o'zgartirgan bo'lishi mumkin — filiallarga.
    await syncBranchesOf(env, member.tenant_id).catch(() => undefined)
    return
  }
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
  await answer(errText(l, r.error.code, r.error.params ?? {}), true)
  if (r.draft) await edit(r.draft, '', true)
}

// ---------------------------------------------------------------------------
// Widget karta (draftWidget.ts): yuborish, yangilash, tahrir so'rovlari.

const plainFill = (s: string, p: Record<string, unknown> = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? ''))

/** Muammo matni (oddiy matn — widget'da textContent). */
function issueText(l: Lang): IssueText {
  const t = T[l]
  return (i, d) => (d.kind === 'unknown' && i.code === 'unknown' ? '' : plainFill(t.issue[i.code === 'currencyMismatch' && d.fx ? 'currencyMismatchFx' : i.code] ?? i.code, i.params))
}

/** Saqlash xatosi matni (qoldiq yetmasa — tovar va qoldiq bilan). */
function errText(l: Lang, code: string, params: Record<string, unknown>): string {
  const t = T[l]
  if (code === 'cloud.errors.insufficientStock' && params.name) {
    return `${String(params.name)}: ${t.issue.insufficientStock.replace('{name}: ', '').replace('{stock}', String(params.stock)).replace('{unit}', String(params.unit ?? ''))}`
  }
  return t.err[code] ?? t.errFallback
}

const plainMoney = (n: number, d: Draft) => {
  const code = d.spokenCurrency && d.issues.some((i) => i.code === 'currencyMismatch') ? d.spokenCurrency : null
  return code ? `${fmt(n)} ${CUR_SIGN[code] ?? code}` : `${fmt(n)} ${d.currency}`
}

function widgetCaption(drafts: Draft[], l: Lang, tag: string): string {
  return tag + escapeHtml(draftWidgetCaption(drafts, l, (d) => T[l].kind[d.kind], plainMoney))
}

/** Widget ostidagi tugmalar: ochiq amal bo'lsa — tasdiqlash/bekor (butun guruh) + ilovada ochish; bo'lmasa — yo'q. */
function groupKeyboard(env: Env, g: string, rows: GroupRow[], l: Lang) {
  const t = T[l]
  const open = rows.filter((r) => r.draft.status === 'new' && !r.expired && !chatOnly(r.draft))
  if (!open.length) return { inline_keyboard: [] as unknown[] }
  return {
    inline_keyboard: [
      [{ text: open.length > 1 ? t.confirmAll : t.confirm, callback_data: `A:${g}` }, { text: t.cancel, callback_data: `X:${g}` }],
      [{ text: t.edit, web_app: { url: appUrl(env, `?draft=${open[0].draft.id}`) } }],
    ],
  }
}

async function withRates(env: Env, tenantId: string, rows: GroupRow[]): Promise<GroupRow[]> {
  return Promise.all(rows.map(async (r) => (r.draft.status === 'new' && !r.expired ? { ...r, draft: await withFx(env, tenantId, r.draft) } : r)))
}

async function sendDraftWidget(env: Env, chatId: number, m: MemberWithTenant, g: string, drafts: Draft[], l: Lang, tag: string, reply: Record<string, unknown>): Promise<TgResult<{ message_id: number }>> {
  const rows = await withRates(env, m.tenant_id, drafts.map((draft) => ({ draft, expired: false })))
  return tgCall<{ message_id: number }>(env, 'sendWidget', {
    chat_id: chatId,
    html: draftWidgetHtml(l),
    chat_data: draftWidgetData(g, rows, l, issueText(l), m.role === 'owner', drafts[0].currency, new Date()),
    caption: widgetCaption(drafts, l, tag),
    parse_mode: 'HTML',
    allow_queries: true,
    ...reply,
    reply_markup: groupKeyboard(env, g, rows, l),
  })
}

/** Bir nechta faol do'kon bo'lsa — qaysi do'konniki (karta izohida). */
async function tagFor(env: Env, uid: number, tenantId: string): Promise<string> {
  const active = (await listMemberships(env.DB, uid)).filter((x) => x.active)
  const m = active.find((x) => x.tenant_id === tenantId)
  return active.length > 1 && m ? `🏪 <b>${escapeHtml(m.tenant.name)}</b>\n` : ''
}

/** Guruhning joriy holati → widget ma'lumoti, izoh va tugmalar (hammasi bo'lsa — tugmalar olib tashlanadi). */
export async function refreshDraftWidget(env: Env, tenantId: string, actor: { uid: number; role: 'owner' | 'cashier'; name: string }, g: string, chatId: number, msgId: number, l: Lang, errors: Record<string, string> = {}): Promise<void> {
  const rows = (await env.SHOP.getByName(tenantId).assistantGroup(actor, g)) as GroupRow[] | null
  const acts = (rows ?? []).filter((r) => !chatOnly(r.draft))
  if (!acts.length) return
  const data = draftWidgetData(g, await withRates(env, tenantId, acts), l, issueText(l), actor.role === 'owner', acts[0].draft.currency, new Date(), errors)
  const w = await tgCall(env, 'editMessageWidgetData', { chat_id: chatId, message_id: msgId, chat_data: data })
  if (!w.ok) console.warn('editMessageWidgetData:', w.status, w.description)
  const kb = groupKeyboard(env, g, acts, l)
  const caption = widgetCaption(acts.map((r) => r.draft), l, await tagFor(env, actor.uid, tenantId))
  const c = await tgCall(env, 'editMessageCaption', { chat_id: chatId, message_id: msgId, caption, parse_mode: 'HTML', reply_markup: kb })
  if (!c.ok && !/not modified/i.test(c.description)) await tgCall(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: kb })
}

/** Ilovada o'zgargan qoralama botda widget kartada turgan bo'lsa — karta yangilanadi. */
export async function syncDraftCard(env: Env, tenantId: string, actor: { uid: number; role: 'owner' | 'cashier'; name: string }, d: Draft | null): Promise<void> {
  if (!d?.card?.w) return
  await refreshDraftWidget(env, tenantId, actor, d.partOf ?? d.id, d.card.chat, d.card.msg, langOf(undefined, d)).catch(() => undefined)
}

const MONEY = /^\d{1,12}(?:\.\d{1,4})?$/
const SALE_METHODS: Draft['method'][] = ['cash', 'card', 'debt']
const PAY_METHODS: Draft['method'][] = ['cash', 'card', 'transfer']

/** Widget so'rovi → qoralama tuzatishi (null — yaroqsiz). Sonlar qat'iy tekshiriladi. */
export function widgetEdit(op: string, arg: string, d: Draft): DraftEdits | null {
  const money = (s: string) => (MONEY.test(s) ? Number(s) : null)
  switch (op) {
    case 'm': {
      const method = METHOD_OF[arg as MethodCode]
      const allowed = d.kind === 'sale' ? SALE_METHODS : d.kind === 'payment_in' || d.kind === 'payment_out' ? PAY_METHODS : []
      return method && allowed.includes(method) ? { method } : null
    }
    case 'a': { const n = money(arg); return n !== null && n > 0 ? { amount: n } : null }
    case 'd': { const n = money(arg); return n !== null && d.kind === 'sale' ? { paid: n } : null }
    case 'c':
      if (arg === 'n') return d.customerQuery ? { newCustomer: d.customerQuery } : null
      return /^\d{1,12}$/.test(arg) && Number(arg) > 0 ? { customerId: Number(arg) } : null
    case 'g': { const c = /^\d$/.test(arg) ? EXPENSE_CATEGORIES[Number(arg)] : undefined; return c && d.kind === 'expense' ? { category: c } : null }
    case 'r': { const n = money(arg); return n !== null && n > 0 && n <= 1e7 ? { rate: n } : null }
    case 'i': {
      const x = /^(\d{1,2}):([pqv]):(\d{1,12}(?:\.\d{1,4})?)$/.exec(arg)
      if (!x || !d.items[Number(x[1])]) return null
      const index = Number(x[1]), n = Number(x[3])
      if (x[2] === 'p') return Number.isInteger(n) && n > 0 ? { item: { index, productId: n } } : null
      if (x[2] === 'q') return n <= 1e6 ? { item: { index, qty: n } } : null
      return { item: { index, price: n } }
    }
    case 'h': {
      const x = /^(\d{1,2}):(x|\d{1,12}(?:\.\d{1,4})?)$/.exec(arg)
      if (!x || d.kind !== 'customer' || !(d.people ?? [])[Number(x[1])]) return null
      return x[2] === 'x' ? { person: { index: Number(x[1]), remove: true } } : { person: { index: Number(x[1]), amount: Number(x[2]) } }
    }
  }
  return null
}

/**
 * Widget kartadagi tahrir: `y<op>:<qoralama id>[:arg]` — x bekor, m usul, a summa, d hozir to'langan, c mijoz (n — yangi),
 * g toifa, r kurs, i tovar qatori (`<n>:<p|q|v>:<son>`), h yangi mijoz qatori (`<n>:<summa|x>`). Faqat qoralama egasi.
 * Javob avval ('ok'/'gone'/'forbidden'/'bad'), keyin karta yangi holat bilan qayta chiziladi.
 */
export async function handleDraftQuery(env: Env, q: WidgetQuery): Promise<void> {
  const answer = (data: string) => tgCall(env, 'answerWidgetQuery', { widget_query_id: q.id, data })
  const hit = /^y([xmadcgrih]):([a-f0-9]{16})(?::([0-9a-z.:]{1,40}))?$/.exec(q.data ?? '')
  if (!hit || !q.chat || !q.message_id) { await answer('bad'); return }
  const [, op, id, arg = ''] = hit
  const m = await draftOwner(env, q.from.id, id)
  if (!m || !m.active) { await answer('forbidden'); return }
  const shop = env.SHOP.getByName(m.tenant_id)
  const actor = { uid: m.uid, role: m.role, name: m.name }
  const d = (await shop.assistantGet(actor, id)) as Draft | null
  if (!d) { await answer('gone'); return }
  let code = 'ok'
  if (d.status !== 'new') code = 'gone'
  else if (op === 'x') await shop.assistantCancel(actor, id)
  else {
    const e = widgetEdit(op, arg, d)
    if (e) await shop.assistantUpdate(actor, id, e)
    else code = 'bad'
  }
  await answer(code)
  await refreshDraftWidget(env, m.tenant_id, actor, d.partOf ?? d.id, q.chat.id, q.message_id, langOf(q.from.language_code, d))
  console.log(JSON.stringify({ evt: 'widget_draft', op, code }))
}
