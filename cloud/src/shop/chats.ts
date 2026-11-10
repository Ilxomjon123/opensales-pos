import type { Sql } from './sql'
import type { Actor } from './rpc'
import { DRAFT_TTL_MS, evaluate, randomDraftId, type Draft, type VoiceMeta } from './assistant'

// Ilovadagi yordamchi chatlari. Chat — shu chatga tegishli qoralamalar (har xabar = bitta qoralama).
// Egasi — faqat yaratgan foydalanuvchi; boshqa a'zo ko'rmaydi va davom ettira olmaydi.

const CHAT_ID = /^[a-f0-9]{16}$/
const TITLE_MAX = 60
const KEEP_DAYS = 90

/** Mavjud chat (egasi shu odam) yoki yangisi. Noto'g'ri/begona id — yangi chat. */
export function openChat(sql: Sql, uid: number, chatId: string | null, now: string): string {
  if (chatId && CHAT_ID.test(chatId) && sql.get('SELECT 1 FROM assistant_chats WHERE id = ? AND uid = ?', chatId, uid)) return chatId
  const id = randomDraftId()
  sql.run('INSERT INTO assistant_chats(id, uid, title, created_at, updated_at) VALUES(?, ?, ?, ?, ?)', id, uid, '', now, now)
  return id
}

/** Xabardan keyin: oxirgi faollik va (birinchi xabardan) sarlavha. */
export function touchChat(sql: Sql, chatId: string, transcript: string, now: string) {
  const title = transcript.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  sql.run("UPDATE assistant_chats SET updated_at = ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?", now, title, chatId)
}

export type ChatRow = { id: string; title: string; updated_at: string; last: string | null; count: number }

export function listChats(sql: Sql, uid: number): ChatRow[] {
  return sql.all<ChatRow>(
    `SELECT c.id, c.title, c.updated_at,
            (SELECT d.transcript FROM assistant_drafts d WHERE d.chat_id = c.id ORDER BY d.created_at DESC LIMIT 1) last,
            (SELECT COUNT(*) FROM assistant_drafts d WHERE d.chat_id = c.id) count
     FROM assistant_chats c WHERE c.uid = ? AND c.title <> '' ORDER BY c.updated_at DESC LIMIT 50`,
    uid,
  )
}

export type ChatEntry = { draft: Draft; at: string; voice: VoiceMeta | null; expired: boolean }

/** Chat tarixi (eskidan yangiga). Ochiq qoralama qayta baholanadi; muddati o'tgani — "expired". */
export function chatEntries(sql: Sql, actor: Actor, chatId: string, now: string): ChatEntry[] | null {
  if (!CHAT_ID.test(chatId) || !sql.get('SELECT 1 FROM assistant_chats WHERE id = ? AND uid = ?', chatId, actor.uid)) return null
  const rows = sql.all<{ draft: string; created_at: string; voice: string | null }>(
    'SELECT draft, created_at, voice FROM assistant_drafts WHERE chat_id = ? AND uid = ? ORDER BY created_at ASC LIMIT 300', chatId, actor.uid,
  )
  return rows.flatMap((r) => {
    let d: Draft
    try { d = JSON.parse(r.draft) as Draft } catch { return [] }
    let voice: VoiceMeta | null = null
    try { voice = r.voice ? (JSON.parse(r.voice) as VoiceMeta) : null } catch { /* */ }
    const expired = d.status === 'new' && Date.parse(now) - Date.parse(r.created_at) > DRAFT_TTL_MS
    return [{ draft: d.status === 'new' && !expired ? evaluate(sql, d, actor) : d, at: r.created_at, voice, expired }]
  })
}

export function deleteChat(sql: Sql, uid: number, chatId: string): boolean {
  if (!CHAT_ID.test(chatId) || !sql.get('SELECT 1 FROM assistant_chats WHERE id = ? AND uid = ?', chatId, uid)) return false
  sql.tx(() => {
    sql.run('DELETE FROM assistant_drafts WHERE chat_id = ? AND uid = ?', chatId, uid)
    sql.run('DELETE FROM assistant_chats WHERE id = ?', chatId)
  })
  return true
}

/** Kunlik tozalash: 90 kun ishlatilmagan chatlar (qoralamalari bilan). */
export function pruneChats(sql: Sql, now: number) {
  const cutoff = new Date(now - KEEP_DAYS * 24 * 3600_000).toISOString()
  sql.run('DELETE FROM assistant_drafts WHERE chat_id IN (SELECT id FROM assistant_chats WHERE updated_at < ?)', cutoff)
  sql.run('DELETE FROM assistant_chats WHERE updated_at < ?', cutoff)
}
