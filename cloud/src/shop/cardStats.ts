import type { Sql } from './sql'

// Bot "Savdo" kartasi (telegram/salesCard.ts) uchun do'kon raqamlari. Davr ko'rsatkichlari Hisobot sahifasi
// op'laridan (businessSummary + reportSummary — formula bitta, UTC kun); bu yerda faqat qo'shimchasi:
// oxirgi 7 kunning sof savdosi (savdo − vozvrat) grafik uchun.

export type CardStats = {
  shop: string
  currency: string
  total: number; count: number; profit: number; cash: number; card: number; debt: number; returns: number; expenses: number
  receivable: number; debtors: number
  /** Oxirgi 7 UTC kun (eskidan → bugun) sof savdo. */
  week: number[]
  top: { name: string; total: number }[]
}

const DAY = 86_400_000
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function weekSeries(sql: Sql, today: string): number[] {
  const end = Date.parse(today + 'T00:00:00Z')
  const days = Array.from({ length: 7 }, (_, i) => isoDay(end - (6 - i) * DAY))
  const rows = sql.all<{ d: string; v: number }>(
    `SELECT d, SUM(v) v FROM (
       SELECT date(created_at) d, total v FROM sales WHERE date(created_at) BETWEEN ? AND ?
       UNION ALL
       SELECT date(created_at) d, -amount v FROM sale_returns WHERE date(created_at) BETWEEN ? AND ?
     ) GROUP BY d`, days[0], days[6], days[0], days[6],
  )
  const by = new Map(rows.map((r) => [r.d, r.v]))
  return days.map((d) => by.get(d) ?? 0)
}

export function settingOf(sql: Sql, key: string, fallback: string): string {
  return sql.get<{ value: string | null }>('SELECT value FROM settings WHERE key = ?', key)?.value || fallback
}
