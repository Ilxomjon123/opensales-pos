import type { Env } from '../env'
import { escapeHtml, tgCall, webAppButton } from './api'
import { defaultMembership, findMembership, findTenantByPrefix, inviteInfo, listMemberships, listTenants, setActiveTenant, setPaidUntil, setTenantStatus, subscriptionOf, tenantState, tenantUntil, trialDays, type TenantRow } from '../registry'
import { botAssistant, botAssistantCallback } from './assistantBot'
import { cleanSrc, quietly, trackStart } from '../funnel'
import { relayFromAdmin, relayIncoming, type RelayMsg } from './relay'
import { FUNNEL_PERIODS, handleWidgetQuery, sendFunnelWidget, type WidgetQuery } from './funnelWidget'
import { handleSalesQuery, sendSalesCard } from './salesWidget'

// Platforma boti (@OpenSalesKassaBot kabi): /start → mini app tugmasi; kassir taklifi;
// admin (ADMIN_CHAT_ID) buyruqlari. Webhook doim 200 qaytaradi — Telegram qayta yubormasin.

type Update = {
  message?: {
    message_id?: number
    chat: { id: number; type: string }
    from?: { id: number; language_code?: string; first_name?: string; last_name?: string; username?: string }
    text?: string
    caption?: string
    reply_to_message?: RelayMsg['reply_to_message']
    voice?: { file_id: string; duration: number; file_size?: number }
    audio?: { file_id: string; duration: number; file_size?: number }
  }
  callback_query?: { id: string; from: { id: number; language_code?: string }; data?: string; message?: { chat: { id: number }; message_id: number } }
  /** Bot API 10.4: HTML widget kartasidan so'rov (funnelWidget.ts). */
  widget_query?: WidgetQuery
}

type Lang = 'uz' | 'ru'
const T: Record<Lang, Record<string, string>> = {
  uz: {
    welcome: "Assalomu alaykum! <b>OpenSales Kassa</b> — telefondan savdo: chek, qarz daftari, qoldiq va hisobot.\n\n{days} kun bepul. Boshlash uchun tugmani bosing.",
    open: '🧾 Kassani ochish',
    invite: "Sizni <b>{shop}</b> do'koniga kassir sifatida taklif qilishdi. Qo'shilish uchun tugmani bosing.",
    inviteOwner: "Sizni <b>{shop}</b> do'koniga <b>egasi</b> sifatida (to'liq huquq) ulashmoqda. Qo'shilish uchun tugmani bosing.",
    inviteGone: "Bu taklif havolasi ishlamaydi (muddati o'tgan, ishlatilgan yoki bekor qilingan). Egasidan yangisini so'rang.",
    join: "🤝 Qo'shilish",
    help: 'Kassani ochish uchun tugmani bosing.',
    shops: "Yordamchi qaysi do'konga yozsin? Hozirgisi ✅ bilan belgilangan.",
    oneShop: "Sizda bitta do'kon: <b>{shop}</b>. Yangi do'konni ilovada «Ko'proq» bo'limidan ochasiz.",
    noShop: "Siz hali hech qaysi do'konga ulanmagansiz.",
    shopSet: "✅ Endi yordamchi <b>{shop}</b> do'koniga yozadi.",
    ownerOnly: "Savdo kartasi faqat do'kon egasi uchun.",
    cardFailed: "Kartani yuborib bo'lmadi. Hisobotni ilovada oching.",
  },
  ru: {
    welcome: 'Здравствуйте! <b>OpenSales Kassa</b> — продажи с телефона: чеки, долги клиентов, остатки и отчёты.\n\n{days} дней бесплатно. Нажмите кнопку, чтобы начать.',
    open: '🧾 Открыть кассу',
    invite: 'Вас пригласили кассиром в магазин <b>{shop}</b>. Нажмите кнопку, чтобы присоединиться.',
    inviteOwner: 'Вас подключают к магазину <b>{shop}</b> как <b>владельца</b> (полный доступ). Нажмите кнопку, чтобы присоединиться.',
    inviteGone: 'Эта ссылка-приглашение не работает (истекла, использована или отменена). Попросите у владельца новую.',
    join: '🤝 Присоединиться',
    help: 'Нажмите кнопку, чтобы открыть кассу.',
    shops: 'В какой магазин записывать помощнику? Текущий отмечен ✅.',
    oneShop: 'У вас один магазин: <b>{shop}</b>. Новый магазин открывается в приложении в разделе «Ещё».',
    noShop: 'Вы пока не подключены ни к одному магазину.',
    shopSet: '✅ Теперь помощник записывает в магазин <b>{shop}</b>.',
    ownerOnly: 'Карточка продаж доступна только владельцу магазина.',
    cardFailed: 'Не удалось отправить карточку. Откройте отчёт в приложении.',
  },
}

const lang = (code?: string): Lang => (code === 'ru' ? 'ru' : 'uz')

function appUrl(env: Env, query = ''): string {
  return env.APP_URL.replace(/\/+$/, '') + '/' + query
}

/** Muddat: Toshkent kuni oxirigacha (UTC+5) — "01.12 gacha" 01.12 kuni ham ishlaydi. */
export function endOfTashkentDay(day: string): string {
  return new Date(Date.parse(`${day}T23:59:59.999+05:00`)).toISOString()
}

function fmtTenant(t: TenantRow & { members?: number; owner_username?: string | null }, now: string): string {
  const until = tenantUntil(t).slice(0, 10)
  const state = { blocked: '⛔', expired: '⌛', paid: '💰', trial: '🆓' }[tenantState(t, now)]
  const who = t.owner_username ? '@' + t.owner_username : String(t.owner_uid)
  return `${state} <code>${t.id.slice(0, 8)}</code> ${escapeHtml(t.name)} — ${escapeHtml(who)} · ${until}${t.members ? ` · ${t.members} kishi` : ''}`
}

async function adminCommand(env: Env, chatId: number, text: string, reply: (t: string, extra?: Record<string, unknown>) => Promise<unknown>, syncSubscription: (t: TenantRow) => Promise<void>) {
  const [cmd, a, b] = text.trim().split(/\s+/)
  const now = new Date().toISOString()
  if (cmd === '/varonka') {
    // Jonli karta (Telegram HTML widget). Davr: /varonka [1|7|30|0], standart 7 kun.
    const days = a === undefined ? 7 : Number(a)
    if (!(FUNNEL_PERIODS as readonly number[]).includes(days)) { await reply('Format: /varonka [1|7|30|0]'); return true }
    const r = await sendFunnelWidget(env, chatId, days)
    if (!r.ok) await reply(`❌ Karta yuborilmadi: ${escapeHtml(r.description)}`)
    return true
  }
  if (cmd === '/admin') {
    await reply("🛠 Admin paneli — do'konlar, obuna muddati, bloklash.", {
      reply_markup: { inline_keyboard: [[{ text: '🛠 Admin panelini ochish', web_app: { url: appUrl(env, 'admin') } }]] },
    })
    return true
  }
  if (cmd === '/tenants') {
    const rows = await listTenants(env.DB, 40)
    await reply(rows.length ? rows.map((t) => fmtTenant(t, now)).join('\n') : "Hali do'kon yo'q.")
    return true
  }
  if (cmd === '/extend') {
    if (!a || !b || !/^\d{4}-\d{2}-\d{2}$/.test(b)) { await reply('Format: /extend &lt;id&gt; YYYY-MM-DD'); return true }
    const t = await findTenantByPrefix(env.DB, a)
    if (!t) { await reply('Topilmadi yoki bir nechta mos keldi.'); return true }
    const until = endOfTashkentDay(b)
    // Obuna biznes (guruh) bo'ylab — filial va boshqa do'konlar ham.
    const rows = await setPaidUntil(env.DB, t.id, until)
    for (const r of rows) await syncSubscription(r)
    await reply(`✅ ${escapeHtml(t.name)}: ${b} gacha (Toshkent kuni oxiri)${rows.length > 1 ? ` · ${rows.length} do'kon` : ''}.`)
    return true
  }
  if (cmd === '/block' || cmd === '/unblock') {
    const t = a ? await findTenantByPrefix(env.DB, a) : null
    if (!t) { await reply('Topilmadi yoki bir nechta mos keldi.'); return true }
    const status = cmd === '/block' ? 'blocked' : 'active'
    const rows = await setTenantStatus(env.DB, t.id, status)
    for (const r of rows) await syncSubscription(r)
    await reply(`${status === 'blocked' ? '⛔' : '✅'} ${escapeHtml(t.name)}: ${status}${rows.length > 1 ? ` · ${rows.length} do'kon` : ''}`)
    return true
  }
  return false
}

export async function handleUpdate(env: Env, update: Update): Promise<void> {
  if (update.widget_query) {
    // Karta turi so'rov boshidan: `d:` — admin varonkasi, `r:` — egalar savdo kartasi.
    const q = update.widget_query
    if (q.data?.startsWith('d:')) await handleWidgetQuery(env, q)
    else if (q.data?.startsWith('r:')) await handleSalesQuery(env, q)
    else await tgCall(env, 'answerWidgetQuery', { widget_query_id: q.id, data: 'bad' })
    return
  }
  if (update.callback_query) {
    if (update.callback_query.data?.startsWith('shop:')) { await shopCallback(env, update.callback_query); return }
    await botAssistantCallback(env, update.callback_query)
    return
  }
  const msg = update.message
  if (!msg || msg.chat.type !== 'private' || !msg.from) return
  // Asoschi yozishmasi (relay.ts): admin odamga javob yozdi / odam asoschi xabariga javob berdi yoki eslatmadan
  // keyin botga yozdi — nusxa asoschiga. Asoschi xabariga reply bo'lsa — AI'ga berilmaydi.
  const rm: RelayMsg = { ...msg, from: msg.from }
  if (await relayFromAdmin(env, rm)) return
  if (await relayIncoming(env, rm)) return
  // Ovozli xabar yoki buyruq bo'lmagan matn — AI yordamchisi (savdo, to'lov, xarajat, kirim).
  if (msg.voice || msg.audio) { await botAssistant(env, { ...msg, from: msg.from }); return }
  if (!msg.text) return
  const l = lang(msg.from.language_code)
  const chatId = msg.chat.id
  const reply = (text: string, extra: Record<string, unknown> = {}) =>
    tgCall(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra })

  if (env.ADMIN_CHAT_ID && String(chatId) === env.ADMIN_CHAT_ID && msg.text.startsWith('/') && !msg.text.startsWith('/start')) {
    const handled = await adminCommand(env, chatId, msg.text, (t, extra) => reply(t, extra), async (t) => {
      await env.SHOP.getByName(t.id).setSubscription(subscriptionOf(t))
    })
    if (handled) return
  }

  const [cmd, payload] = msg.text.trim().split(/\s+/, 2)
  if (cmd === '/start' && payload?.startsWith('inv_') && /^inv_[a-f0-9]{32}$/.test(payload)) {
    const info = await inviteInfo(env.DB, payload.slice(4), new Date())
    if (!info) { await reply(T[l].inviteGone, { reply_markup: webAppButton(T[l].open, appUrl(env)) }); return }
    const text = (info.role === 'owner' ? T[l].inviteOwner : T[l].invite).replace('{shop}', escapeHtml(info.shopName))
    await reply(text, { reply_markup: webAppButton(T[l].join, appUrl(env, `?inv=${payload.slice(4)}`)) })
    return
  }
  if (cmd === '/dokon' || cmd === '/shop') {
    const shops = (await listMemberships(env.DB, msg.from.id)).filter((x) => x.active)
    if (shops.length === 0) { await reply(T[l].noShop, { reply_markup: webAppButton(T[l].open, appUrl(env)) }); return }
    if (shops.length === 1) { await reply(T[l].oneShop.replace('{shop}', escapeHtml(shops[0].tenant.name))); return }
    const cur = (await defaultMembership(env.DB, msg.from.id))?.tenant_id
    await reply(T[l].shops, {
      reply_markup: { inline_keyboard: shops.map((x) => [{ text: `${x.tenant_id === cur ? '✅ ' : ''}${x.tenant.name}`, callback_data: `shop:${x.tenant_id}` }]) },
    })
    return
  }
  if (cmd === '/hisobot' || cmd === '/report') {
    // Egaga jonli savdo kartasi (salesWidget.ts) — joriy do'kon (/dokon bilan tanlangan).
    const m = await defaultMembership(env.DB, msg.from.id)
    if (!m || !m.active) { await reply(T[l].noShop, { reply_markup: webAppButton(T[l].open, appUrl(env)) }); return }
    if (m.role !== 'owner') { await reply(T[l].ownerOnly); return }
    const r = await sendSalesCard(env, chatId, m, l)
    if (!r) await reply(T[l].ownerOnly)
    else if (!r.ok) await reply(T[l].cardFailed, { reply_markup: webAppButton(T[l].open, appUrl(env, 'reports')) })
    return
  }
  if (cmd === '/start') {
    await reply(T[l].welcome.replace('{days}', String(trialDays(env.TRIAL_DAYS))), { reply_markup: webAppButton(T[l].open, appUrl(env)) })
    // Varonka: kim, qaysi reklamadan (t.me/<bot>?start=<manba>). Kassir/egalar ham yoziladi — bosqich takrorlanmaydi.
    const who = { uid: msg.from.id, name: [msg.from.first_name].filter(Boolean).join(' ') || String(msg.from.id), username: msg.from.username ?? null, lang: msg.from.language_code ?? null }
    await quietly(trackStart(env.DB, who, cleanSrc(payload), new Date().toISOString()), 'start')
    return
  }
  if (!msg.text.startsWith('/')) { await botAssistant(env, { ...msg, from: msg.from }); return }
  await reply(T[l].help, { reply_markup: webAppButton(T[l].open, appUrl(env)) })
}

/** /dokon tugmasi: yordamchi yozadigan do'konni tanlash (faqat o'z faol a'zoligi). */
async function shopCallback(env: Env, cb: NonNullable<Update['callback_query']>): Promise<void> {
  const l = lang(cb.from.language_code)
  const id = /^shop:([a-f0-9]{32})$/.exec(cb.data ?? '')?.[1]
  const m = id ? await findMembership(env.DB, cb.from.id, id) : null
  if (!m || !m.active) { await tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id }); return }
  await setActiveTenant(env.DB, cb.from.id, m.tenant_id)
  const text = T[l].shopSet.replace('{shop}', escapeHtml(m.tenant.name))
  await tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: text.replace(/<[^>]+>/g, '') })
  if (cb.message) await tgCall(env, 'editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text, parse_mode: 'HTML' })
}
