import { escapeHtml } from './api'

// Chek → Telegram xabari (HTML): do'kon, chek raqami, tovarlar blockquote ichida, jami va to'lovlar emoji bilan.
// Ilova tayyor (formatlangan, tarjima qilingan) satrlarni yuboradi; bu yerda faqat tuzilma tekshiriladi va
// HAMMA satr escape qilinadi — mijoz HTML kirita olmaydi. Telegram chegarasi 4096 belgi.

export type CardRow = { kind: 'discount' | 'cash' | 'card' | 'change' | 'debt' | 'balance'; label: string; value: string }
export type ReceiptCard = {
  shop: string
  title: string
  meta: string
  items: { name: string; line: string; sum: string }[]
  total: { label: string; value: string }
  rows: CardRow[]
  foot: string | null
}

const ICON: Record<CardRow['kind'], string> = { discount: '🏷', cash: '💵', card: '💳', change: '🔁', debt: '🔴', balance: '📒' }
const MAX_ITEMS = 60

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** Kiruvchi JSON → karta (noto'g'ri bo'lsa null). */
export function parseCard(raw: unknown): ReceiptCard | null {
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null
  if (!o) return null
  const shop = str(o.shop, 80)
  const title = str(o.title, 80)
  const meta = str(o.meta, 160) ?? ''
  const total = (o.total && typeof o.total === 'object' ? o.total : null) as Record<string, unknown> | null
  const tLabel = str(total?.label, 40)
  const tValue = str(total?.value, 40)
  if (!shop || !title || !tLabel || !tValue || !Array.isArray(o.items) || !o.items.length) return null
  const items = o.items.slice(0, MAX_ITEMS).flatMap((x) => {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const name = str(r.name, 120)
    return name ? [{ name, line: str(r.line, 80) ?? '', sum: str(r.sum, 40) ?? '' }] : []
  })
  if (!items.length) return null
  const rows = (Array.isArray(o.rows) ? o.rows : []).slice(0, 8).flatMap((x) => {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const kind = r.kind as CardRow['kind']
    const label = str(r.label, 40)
    const value = str(r.value, 40)
    return kind in ICON && label && value ? [{ kind, label, value }] : []
  })
  return { shop, title, meta, items, total: { label: tLabel, value: tValue }, rows, foot: str(o.foot, 120) }
}

/** Telegram HTML. Ko'p tovarli chek — yig'iladigan blockquote (chatni to'ldirmaydi). */
export function renderCard(c: ReceiptCard, more = 0): string {
  const e = escapeHtml
  const head = [`🧾 <b>${e(c.shop)}</b>`, `<b>${e(c.title)}</b>`, c.meta ? `<i>${e(c.meta)}</i>` : ''].filter(Boolean).join('\n')
  const lines = c.items.map((it) => `▪️ <b>${e(it.name)}</b>\n${e(it.line)}${it.sum ? ` = <b>${e(it.sum)}</b>` : ''}`)
  if (more > 0) lines.push(`… +${more}`)
  const quote = `<blockquote${c.items.length > 4 ? ' expandable' : ''}>${lines.join('\n')}</blockquote>`
  const rows = c.rows.map((r) => (r.kind === 'debt' ? `${ICON[r.kind]} <b>${e(r.label)}: ${e(r.value)}</b>` : `${ICON[r.kind]} ${e(r.label)}: ${e(r.value)}`))
  const parts = [head, quote, [`✅ <b>${e(c.total.label)}: ${e(c.total.value)}</b>`, ...rows].join('\n')]
  if (c.foot) parts.push(`<i>${e(c.foot)}</i>`)
  return parts.join('\n\n')
}

/** Chegaradan oshsa — oxirgi tovarlar "… +N" bilan qisqartiriladi (xabar 4096, rasm izohi 1024). */
export function cardHtml(c: ReceiptCard, limit = 4000): string {
  let card = c
  let html = renderCard(card)
  while (html.length > limit && card.items.length > 1) {
    const keep = Math.max(1, Math.floor(card.items.length * 0.8))
    card = { ...card, items: card.items.slice(0, keep) }
    html = renderCard(card, c.items.length - keep)
  }
  // Rasm izohiga bitta tovar ham sig'masa — tovarlarsiz (ular rasmda bor).
  if (html.length > limit) html = renderCard({ ...card, items: [] }, c.items.length).replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>\n\n/, '')
  return html.slice(0, limit)
}
