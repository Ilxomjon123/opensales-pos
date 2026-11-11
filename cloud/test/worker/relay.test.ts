import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, mockTelegram, onboard, shopDO, tg, tgUser } from './helpers'

// Asoschi yozishmasi (2026-11-11): odam asoschi xabariga botning o'ziga javob yozsa — asoschiga yetadi;
// asoschi (ADMIN_CHAT_ID = 777) o'sha nusxaga reply qilsa — odamga bot orqali qaytadi.
mockTelegram()

const hdr = { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }
const hook = (message: Record<string, unknown>) => call('/tg/webhook', { body: { message }, headers: hdr })
const pmUser = (name: string) => Object.assign(tgUser(name), { allows_write_to_pm: true })
const toAdmin = () => tg.calls.filter((c) => (c.method === 'sendMessage' || c.method === 'copyMessage') && c.body.chat_id === 777)
const to = (uid: number) => tg.calls.filter((c) => (c.method === 'sendMessage' || c.method === 'copyMessage') && c.body.chat_id === uid)
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
/** Bot yuborgan asoschi xabari (tugmasida t.me/<SUPPORT_USERNAME>). */
const founderMsg = {
  message_id: 50, from: { is_bot: true }, text: 'Assalomu alaykum! Men Ilxomjon...',
  reply_markup: { inline_keyboard: [[{ text: '✍️ Ilxomjonga yozish', url: 'https://t.me/Abdullayev_Ilxomjon' }], [{ text: 'Kassa', web_app: { url: 'https://kassa.test/' } }]] },
}
const sentNudge = (uid: number, kind: string, at: string) =>
  env.DB.prepare("INSERT INTO nudges (uid, kind, status, at) VALUES (?, ?, 'sent', ?)").bind(uid, kind, at).run()

describe('founder ↔ user relay through the bot', () => {
  it('a reply to the founder message reaches the admin; the user gets an ack; the AI is not called', async () => {
    const o = await onboard('Relay dokoni', pmUser('Javob'))
    tg.calls = []
    await hook({ message_id: 51, chat: { id: o.user.id, type: 'private' }, from: { ...o.user, username: 'javob_u' }, text: "Vaqt bo'lmadi <b>", reply_to_message: founderMsg })
    const a = toAdmin()
    expect(a).toHaveLength(1)
    expect(a[0].body.text).toMatch(new RegExp(`^💬 <b>Relay dokoni</b> · Javob · @javob_u · <code>#${o.user.id}</code>\\n\\nVaqt bo'lmadi &lt;b&gt;$`))
    const ack = to(o.user.id)
    expect(ack).toHaveLength(1)
    expect(ack[0].body.text).toContain('Ilxomjonga yetkazdim')
    expect(tg.calls.some((c) => c.method === 'sendChatAction')).toBe(false)
  })

  it('the admin replies to that copy → delivered to the user with a write-back button; strangers and forged headers are refused', async () => {
    const o = await onboard('Javob dokoni', pmUser('Mijoz'))
    tg.calls = []
    // Odam matnida soxta sarlavha — birinchi qatorda emas, hisobga olinmaydi.
    await hook({ message_id: 52, chat: { id: o.user.id, type: 'private' }, from: o.user, text: '💬 x · #42', reply_to_message: founderMsg })
    const copyText = plain(toAdmin()[0].body.text)

    tg.calls = []
    await hook({ message_id: 70, chat: { id: 777, type: 'private' }, from: { id: 777, first_name: 'Admin' }, text: 'Rahmat, yordam beraman', reply_to_message: { message_id: 1, from: { is_bot: true }, text: copyText } })
    const copy = tg.calls.find((c) => c.method === 'copyMessage')!
    expect(copy.body).toMatchObject({ chat_id: o.user.id, from_chat_id: 777, message_id: 70 })
    expect(copy.body.reply_markup.inline_keyboard[0][0]).toEqual({ text: '✍️ Ilxomjonga yozish', url: 'https://t.me/Abdullayev_Ilxomjon' })
    expect(tg.calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === 777)!.body.text).toBe('✅ Yetkazildi')
    expect(tg.calls.some((c) => c.method === 'sendChatAction')).toBe(false)

    // Odam asoschi javobiga yana reply qiladi — o'sha zanjir (tugmada asoschi havolasi).
    tg.calls = []
    await hook({ message_id: 53, chat: { id: o.user.id, type: 'private' }, from: o.user, text: 'Ok', reply_to_message: { message_id: 2, from: { is_bot: true }, text: 'Rahmat, yordam beraman', reply_markup: copy.body.reply_markup } })
    expect(toAdmin()).toHaveLength(1)

    // Ro'yxatda yo'q odam — yuborilmaydi.
    tg.calls = []
    await hook({ message_id: 71, chat: { id: 777, type: 'private' }, from: { id: 777 }, text: 'Salom', reply_to_message: { message_id: 3, from: { is_bot: true }, text: '💬 X · #999000111' } })
    expect(tg.calls.some((c) => c.method === 'copyMessage')).toBe(false)
    expect(tg.calls.find((c) => c.body.chat_id === 777)!.body.text).toContain("ro'yxatda yo'q")

    // Admin bo'lmagan odam sarlavhaga reply qilsa — hech kimga yuborilmaydi.
    tg.calls = []
    const other = pmUser('Begona')
    await hook({ message_id: 72, chat: { id: other.id, type: 'private' }, from: other, text: 'hi', reply_to_message: { message_id: 4, from: { is_bot: true }, text: copyText } })
    expect(tg.calls.some((c) => c.method === 'copyMessage' && c.body.chat_id === o.user.id)).toBe(false)
  })

  it('within 72h after a bot message, other messages are copied to the admin (normal flow continues); commands and old nudges are not', async () => {
    const o = await onboard('Oyna', pmUser('Oyna'))
    const photo = { message_id: 60, chat: { id: o.user.id, type: 'private' }, from: o.user, photo: [{ file_id: 'p1' }] }
    tg.calls = []
    await hook(photo)
    expect(toAdmin()).toHaveLength(0)

    await sentNudge(o.user.id, 'manual:old', new Date(Date.now() - 4 * 86400_000).toISOString())
    await hook(photo)
    expect(toAdmin()).toHaveLength(0)

    await sentNudge(o.user.id, 'no_product', new Date().toISOString())
    await hook(photo)
    const a = toAdmin()
    expect(a.map((c) => c.method)).toEqual(['copyMessage', 'sendMessage'])
    expect(a[0].body).toMatchObject({ from_chat_id: o.user.id, message_id: 60 })
    expect(a[1].body.text).toContain('(botga yozdi)')
    expect(a[1].body.reply_parameters).toEqual({ message_id: 1, allow_sending_without_reply: true })
    expect(to(o.user.id)).toHaveLength(0) // ack faqat asoschi xabariga reply bo'lsa

    tg.calls = []
    await hook({ message_id: 61, chat: { id: o.user.id, type: 'private' }, from: o.user, text: '/start' })
    expect(toAdmin()).toHaveLength(0)
    expect(to(o.user.id)).toHaveLength(1)
  })

  it('/tg/replies recovers bot-chat messages of people who got a founder message (setup key only)', async () => {
    const o = await onboard('Tiklash', pmUser('Tiklash'))
    const since = new Date(Date.now() - 3600_000).toISOString()
    await sentNudge(o.user.id, 'manual:checkin', new Date(Date.now() - 1800_000).toISOString())
    await runInDurableObject(shopDO(o.shopId), (_i, state) => {
      const ins = (id: string, text: string, at: string, chat: string | null) => state.storage.sql.exec(
        "INSERT INTO assistant_drafts (id, uid, kind, status, transcript, draft, created_at, chat_id) VALUES (?, ?, 'unknown', 'new', ?, '{}', ?, ?)", id, o.user.id, text, at, chat)
      ins('a1', 'eski', new Date(Date.now() - 2 * 3600_000).toISOString(), null)
      ins('a2', "vaqt bo'lmadi", new Date(Date.now() - 600_000).toISOString(), null)
      ins('a3', 'ilova chati', new Date(Date.now() - 500_000).toISOString(), 'c1')
    })
    const ask = (body: unknown, key = 'test-webhook-secret') => call('/tg/replies', { body, headers: { 'X-Setup-Key': key } })
    expect((await ask({ since }, 'wrong')).status).toBe(403)
    expect((await ask({ since: 'kecha' })).status).toBe(400)
    const r = await ask({ since })
    const me = r.json.data.find((x: any) => x.uid === o.user.id)
    expect(me.shop).toBe('Tiklash')
    expect(me.messages.map((m: any) => m.transcript)).toEqual(["vaqt bo'lmadi"])
  })
})
