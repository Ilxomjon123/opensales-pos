import type { Env } from '../env'
import { escapeHtml, tgCall } from './api'
import { markUnreachable } from '../funnel'

// Asoschi yozishmasi (2026-11-11). Asoschi xabari (`/tg/outreach`) yoki avtomatik eslatmaga odam BOTNING o'ziga
// javob yozsa, xabar AI yordamchiga ketib yo'qolardi — asoschi ko'rmasdi. Endi:
//  * outreach xabariga (tugmasida t.me/<SUPPORT_USERNAME> bor) REPLY → nusxa adminga, odamga "yetkazdim", AI'ga EMAS;
//  * oxirgi 72 soatda bot unga eslatma/asoschi xabari yuborgan bo'lsa, oddiy xabari ham nusxa sifatida adminga
//    boradi (AI odatdagidek ishlaydi — ovoz bilan tovar qo'shmoqchi bo'lsa buzilmaydi);
//  * admin shu nusxaga (bot chatida) reply qilsa — bot o'sha odamga yetkazadi ("✍️ Ilxomjonga yozish" tugmasi bilan,
//    odam unga reply qilsa yana shu zanjirga tushadi).
// Admin xabaridagi sarlavha birinchi qatorda `#<uid>` — odam matni undan OLDIN turolmaydi (soxta manzil yo'q).

export type RelayMsg = {
  message_id?: number
  chat: { id: number }
  from: { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string }
  text?: string
  caption?: string
  reply_to_message?: {
    message_id: number
    from?: { is_bot?: boolean }
    text?: string
    caption?: string
    reply_markup?: { inline_keyboard?: { text?: string; url?: string }[][] }
  }
}

const WINDOW_MS = 72 * 3600_000
const HEADER = /^💬[^\n]*#(\d{1,15})\b/

/** Admin chati (ADMIN_CHAT_ID ro'yxatidagi birinchisi). */
export function adminChat(env: Env): number | null {
  const id = Number((env.ADMIN_CHAT_ID ?? '').split(',')[0]?.trim())
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

const supportUrl = (env: Env) => (env.SUPPORT_USERNAME ? `https://t.me/${env.SUPPORT_USERNAME}` : null)

/** Bot yuborgan asoschi xabariga (yoki asoschi javobiga) reply — tugmada asoschi havolasi bor. */
export function isFounderThread(env: Env, msg: RelayMsg): boolean {
  const r = msg.reply_to_message
  const url = supportUrl(env)
  if (!r?.from?.is_bot || !url) return false
  return !!r.reply_markup?.inline_keyboard?.some((row) => row.some((b) => b.url === url))
}

/** Oxirgi 72 soatda bot unga eslatma yoki asoschi xabarini yetkazganmi. */
async function inWindow(env: Env, uid: number, now: Date): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM nudges WHERE uid = ? AND status = 'sent' AND at >= ? LIMIT 1")
    .bind(uid, new Date(now.getTime() - WINDOW_MS).toISOString()).first())
}

const L = {
  uz: { ack: "Rahmat! Ilxomjonga yetkazdim — tez orada shu yerda javob beradi.", write: '✍️ Ilxomjonga yozish' },
  ru: { ack: 'Спасибо! Передал Ильхомжону — он скоро ответит здесь.', write: '✍️ Написать Ильхомжону' },
}
const langOf = (code?: string) => (code === 'ru' ? 'ru' : 'uz')

async function header(env: Env, msg: RelayMsg, thread: boolean): Promise<string> {
  const f = msg.from
  const shop = await env.DB.prepare(
    `SELECT t.name FROM funnel_users fu JOIN tenants t ON t.id = fu.shop_id WHERE fu.uid = ?
     UNION ALL SELECT t.name FROM members m JOIN tenants t ON t.id = m.tenant_id WHERE m.uid = ? AND m.active = 1 LIMIT 1`,
  ).bind(f.id, f.id).first<{ name: string }>().catch(() => null)
  const name = [f.first_name, f.last_name].filter(Boolean).join(' ') || String(f.id)
  const who = [shop?.name ? `<b>${escapeHtml(shop.name)}</b>` : null, escapeHtml(name), f.username ? '@' + escapeHtml(f.username) : null].filter(Boolean).join(' · ')
  return `💬 ${who} · <code>#${f.id}</code>${thread ? '' : ' · (botga yozdi)'}`
}

/**
 * Odamning xabari (admin emas). Qaytaradi: true — xabar shu yerda tugadi (asoschiga javob), AI'ga berilmasin.
 * Xato bo'lsa jim (log) — odamning odatdagi oqimi buzilmaydi.
 */
export async function relayIncoming(env: Env, msg: RelayMsg, now = new Date()): Promise<boolean> {
  const admin = adminChat(env)
  if (!admin || msg.from.id === admin || !msg.message_id) return false
  const text = msg.text ?? ''
  if (text.startsWith('/')) return false
  const thread = isFounderThread(env, msg)
  if (!thread && !(await inWindow(env, msg.from.id, now))) return false
  try {
    const head = await header(env, msg, thread)
    if (text) {
      await tgCall(env, 'sendMessage', { chat_id: admin, text: `${head}\n\n${escapeHtml(text)}`, parse_mode: 'HTML', disable_web_page_preview: true })
    } else {
      // Ovoz, rasm, stiker... — asl xabar nusxasi + unga reply qilingan sarlavha (admin sarlavhaga javob beradi).
      const copy = await tgCall<{ message_id: number }>(env, 'copyMessage', { chat_id: admin, from_chat_id: msg.chat.id, message_id: msg.message_id })
      await tgCall(env, 'sendMessage', {
        chat_id: admin, text: head, parse_mode: 'HTML',
        ...(copy.ok ? { reply_parameters: { message_id: copy.result.message_id, allow_sending_without_reply: true } } : {}),
      })
    }
  } catch (e) {
    console.error('relay in:', e instanceof Error ? e.message : e)
    return false
  }
  console.log(JSON.stringify({ evt: 'relay_in', uid: msg.from.id, thread }))
  if (!thread) return false
  await tgCall(env, 'sendMessage', { chat_id: msg.chat.id, text: L[langOf(msg.from.language_code)].ack, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } })
  return true
}

/**
 * Admin bot chatida sarlavhali nusxaga reply qildi → o'sha odamga yetkaziladi. Qaytaradi: true — bu relay javobi edi.
 * Faqat varonka yoki a'zolar ro'yxatidagi odamga (begona uid'ga yozilmaydi).
 */
export async function relayFromAdmin(env: Env, msg: RelayMsg): Promise<boolean> {
  const admin = adminChat(env)
  const r = msg.reply_to_message
  if (!admin || msg.chat.id !== admin || !r?.from?.is_bot || !msg.message_id) return false
  const uid = Number(HEADER.exec(r.text ?? r.caption ?? '')?.[1])
  if (!Number.isSafeInteger(uid) || uid <= 0) return false
  const say = (text: string) => tgCall(env, 'sendMessage', { chat_id: admin, text, reply_parameters: { message_id: msg.message_id!, allow_sending_without_reply: true } })
  const known = await env.DB.prepare('SELECT lang FROM funnel_users WHERE uid = ? UNION ALL SELECT NULL FROM members WHERE uid = ? LIMIT 1').bind(uid, uid).first<{ lang: string | null }>()
  if (!known) { await say('❌ Bu odam ro\'yxatda yo\'q — yuborilmadi.'); return true }
  const write = supportUrl(env)
  const sent = await tgCall(env, 'copyMessage', {
    chat_id: uid, from_chat_id: admin, message_id: msg.message_id,
    ...(write ? { reply_markup: { inline_keyboard: [[{ text: L[langOf(known.lang ?? undefined)].write, url: write }]] } } : {}),
  })
  console.log(JSON.stringify({ evt: 'relay_out', uid, ok: sent.ok }))
  if (sent.ok) { await say('✅ Yetkazildi'); return true }
  await markUnreachable(env.DB, uid, sent.description)
  await say(`❌ Yetkazilmadi: ${sent.description}`)
  return true
}
