import type { Env } from '../env'
import { currencyCode, type Draft } from '../shop/assistant'

// Valyuta kursi taklifi: narx boshqa valyutada aytilgan qoralamani chatning o'zida tasdiqlash uchun.
// Avval do'konning oxirgi ishlatgan kursi (o'zi kiritgan — bozor kursi), bo'lmasa Markaziy bank kursi
// (faqat do'kon valyutasi so'm bo'lsa). Kurs chaqiruvchiga ko'rsatiladi va tugmaga yoziladi — jim ishlatilmaydi.

export type Fx = { from: string; to: string; rate: number; source: 'saved' | 'cbu'; date: string | null }

const CBU_URL = 'https://cbu.uz/uz/arkhiv-kursov-valyut/json/'
let cache: { at: number; rates: Record<string, { rate: number; date: string }> } | null = null

export async function cbuRates(fetcher: typeof fetch = fetch): Promise<Record<string, { rate: number; date: string }> | null> {
  if (cache && Date.now() - cache.at < 3600_000) return cache.rates
  try {
    const res = await fetcher(CBU_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null
    const arr = (await res.json()) as { Ccy?: string; Rate?: string; Nominal?: string; Date?: string }[]
    const rates: Record<string, { rate: number; date: string }> = {}
    for (const r of Array.isArray(arr) ? arr : []) {
      const rate = Number(r.Rate) / (Number(r.Nominal) || 1)
      if (r.Ccy && /^[A-Z]{3}$/.test(r.Ccy) && rate > 0) rates[r.Ccy] = { rate: Math.round(rate * 100) / 100, date: r.Date ?? '' }
    }
    if (!Object.keys(rates).length) return null
    cache = { at: Date.now(), rates }
    return rates
  } catch {
    return null
  }
}

export async function suggestFx(env: Env, tenantId: string, d: Draft): Promise<Fx | null> {
  if (d.status !== 'new' || !d.spokenCurrency || !d.issues.some((i) => i.code === 'currencyMismatch')) return null
  const from = d.spokenCurrency
  const to = currencyCode(d.currency)
  if (!to || from === to || !/^[A-Z]{3}$/.test(from)) return null
  const saved = (await env.SHOP.getByName(tenantId).fxSaved(from, to)) as number | null
  if (saved && saved > 0) return { from, to, rate: saved, source: 'saved', date: null }
  if (to === 'UZS') {
    const r = (await cbuRates())?.[from]
    if (r) return { from, to, rate: r.rate, source: 'cbu', date: r.date || null }
  }
  return null
}

/** Javobga kurs taklifini qo'shadi (qoralama bazada o'zgarmaydi). */
export async function withFx<T extends Draft | null>(env: Env, tenantId: string, d: T): Promise<T> {
  if (!d) return d
  return { ...d, fx: await suggestFx(env, tenantId, d) }
}
