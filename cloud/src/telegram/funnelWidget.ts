import type { Env } from '../env'
import { tgCall, type TgResult } from './api'
import { funnelReport } from '../funnel'
import { isAdminUid } from '../registry'
import { FUNNEL_PERIODS, FUNNEL_WIDGET_HTML, funnelCaption, funnelWidgetData } from './funnelCard'

export { FUNNEL_PERIODS }

// Varonka kartasi — Telegram HTML widget (Bot API 10.4, 2026-11-09). Admin chatida `/varonka` → bot jonli karta
// yuboradi; karta ichidagi davr / 🔄 tugmalari botga `widget_query` (`d:<kun>`) yuboradi → bot javob beradi
// (15 s ichida, "do slow work after answering") → varonkani qayta hisoblab `editMessageWidgetData` bilan
// kartaning `chat_data`sini almashtiradi → karta `chatDataChanged` bilan qayta chiziladi.
// Widget sandbox'da (QuickJS, tarmoq YO'Q) ishlaydi: hamma ma'lumot chat_data'da (≤1024 bayt), HTML ≤32 KB va
// zlib(9) bilan ≤4096 bayt (test qulflaydi). Prod'da widget faqat bot bilan shaxsiy chatda ishlaydi.
// Ism/do'kon nomlari foydalanuvchidan — kartada faqat `textContent` bilan chiziladi (HTML sifatida EMAS).

export async function sendFunnelWidget(env: Env, chatId: number, days: number, now = new Date()): Promise<TgResult<unknown>> {
  const report = await funnelReport(env, days, now)
  const app = env.APP_URL.replace(/\/+$/, '')
  return tgCall(env, 'sendWidget', {
    chat_id: chatId,
    html: FUNNEL_WIDGET_HTML,
    chat_data: funnelWidgetData(report, now),
    caption: funnelCaption(report.stages, days),
    allow_queries: true,
    reply_markup: { inline_keyboard: [[{ text: '🛠 Admin paneli', web_app: { url: `${app}/admin` } }]] },
  })
}

export type WidgetQuery = {
  id: string
  from: { id: number }
  chat?: { id: number; type?: string }
  message_id?: number
  data?: string
}

/**
 * Kartadan kelgan so'rov. Faqat admin (ADMIN_CHAT_ID) va faqat `d:<1|7|30|0>`. Har so'rovga javob beriladi
 * (xato bo'lsa ham — karta holatni ko'rsatadi); hisoblash javobdan KEYIN, natija — kartaning yangi chat_data'si.
 */
export async function handleWidgetQuery(env: Env, q: WidgetQuery, now = new Date()): Promise<void> {
  const answer = (data: string) => tgCall(env, 'answerWidgetQuery', { widget_query_id: q.id, data })
  if (!isAdminUid(env.ADMIN_CHAT_ID, q.from.id)) { await answer('forbidden'); return }
  const days = Number(/^d:(\d{1,2})$/.exec(q.data ?? '')?.[1] ?? NaN)
  if (!(FUNNEL_PERIODS as readonly number[]).includes(days) || !q.chat || !q.message_id) { await answer('bad'); return }
  await answer('ok')
  const report = await funnelReport(env, days, now)
  const r = await tgCall(env, 'editMessageWidgetData', { chat_id: q.chat.id, message_id: q.message_id, chat_data: funnelWidgetData(report, now) })
  // "message is not modified" — holat o'zgarmagan, bajarilgan deb hisoblanadi.
  console.log(JSON.stringify({ evt: 'widget_funnel', days, ok: r.ok, error: r.ok ? undefined : r.description }))
}
