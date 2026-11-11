import type { Env } from '../env'
import { tgCall, webAppButton, type TgResult } from './api'
import { findMembership, type MemberWithTenant } from '../registry'
import { shopStub } from '../catalog'
import { periodRange } from '../shop/answers'
import type { CardStats } from '../shop/cardStats'
import { CARD_PERIODS, salesCaption, salesCardData, salesCardHtml, type CardCode, type CardLang } from './salesCard'
import type { WidgetQuery } from './funnelWidget'

// Egaga "Savdo" kartasi (2026-11-11): botda `/hisobot` → joriy do'kon (defaultMembership) bo'yicha jonli karta.
// Karta tugmalari (davr, 🔄) → `widget_query` `r:<do'kon id>:<t|y|w|m>` → javob 'ok' (15 s ichida) → DO'dan
// raqamlar → `editMessageWidgetData`. Faqat shu do'konning faol EGASI (D1 + DO a'zoligi); kassir — yo'q.

async function stats(env: Env, m: MemberWithTenant, code: CardCode, now: Date): Promise<CardStats | null> {
  const [from, to] = periodRange(CARD_PERIODS[code], now.toISOString())
  const [today] = periodRange('today', now.toISOString())
  return shopStub(env, m.tenant_id).salesCard({ uid: m.uid, role: m.role, name: m.name }, from, to, today)
}

/** null — bu odam do'kon egasi emas (karta yuborilmadi). */
export async function sendSalesCard(env: Env, chatId: number, m: MemberWithTenant, lang: CardLang, now = new Date()): Promise<TgResult<unknown> | null> {
  if (m.role !== 'owner' || !m.active) return null
  const st = await stats(env, m, 't', now)
  if (!st) return null
  return tgCall(env, 'sendWidget', {
    chat_id: chatId,
    html: salesCardHtml(lang),
    chat_data: salesCardData(m.tenant_id, 't', st, now),
    caption: salesCaption(st, 't', lang),
    allow_queries: true,
    reply_markup: webAppButton(lang === 'ru' ? '📊 Открыть отчёт' : '📊 Hisobotni ochish', `${env.APP_URL.replace(/\/+$/, '')}/reports`),
  })
}

export async function handleSalesQuery(env: Env, q: WidgetQuery, now = new Date()): Promise<void> {
  const answer = (data: string) => tgCall(env, 'answerWidgetQuery', { widget_query_id: q.id, data })
  const hit = /^r:([a-f0-9]{32}):([tywm])$/.exec(q.data ?? '')
  if (!hit || !q.chat || !q.message_id) { await answer('bad'); return }
  const m = await findMembership(env.DB, q.from.id, hit[1])
  if (!m || !m.active || m.role !== 'owner') { await answer('forbidden'); return }
  await answer('ok')
  const code = hit[2] as CardCode
  const st = await stats(env, m, code, now)
  if (!st) { console.log(JSON.stringify({ evt: 'widget_sales', ok: false, error: 'not owner in DO' })); return }
  const r = await tgCall(env, 'editMessageWidgetData', { chat_id: q.chat.id, message_id: q.message_id, chat_data: salesCardData(m.tenant_id, code, st, now) })
  console.log(JSON.stringify({ evt: 'widget_sales', code, ok: r.ok, error: r.ok ? undefined : r.description }))
}
