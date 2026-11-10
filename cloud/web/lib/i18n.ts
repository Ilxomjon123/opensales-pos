import { createI18n } from 'vue-i18n'
import { tg } from '../telegram'

// Desktop i18n.ts o'rniga: faqat faol til yuklanadi (ikkalasi ~250KB edi), tanlov shu
// qurilmada (localStorage) — kassir va egasi har xil tilda ishlay oladi.
export type Locale = 'uz' | 'ru'

export const i18n = createI18n({ legacy: false, locale: 'uz', fallbackLocale: 'uz', messages: {} })
export const t = i18n.global.t

export const availableLocales = [
  { code: 'uz', label: "O'zbekcha" },
  { code: 'ru', label: 'Русский' },
] as const

const KEY = 'kassa:locale'

function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object'
      ? merge(out[k] as Record<string, unknown>, v as Record<string, unknown>)
      : v
  }
  return out
}

const loaded = new Set<Locale>()
async function ensure(l: Locale) {
  if (loaded.has(l)) return
  const [base, cloud] = l === 'ru'
    ? await Promise.all([import('../../../src/locales/ru'), import('../locales/ru')])
    : await Promise.all([import('../../../src/locales/uz'), import('../locales/uz')])
  i18n.global.setLocaleMessage(l, merge(base.default as Record<string, unknown>, cloud.default as Record<string, unknown>) as never)
  loaded.add(l)
}

function initial(): Locale {
  try {
    const s = localStorage.getItem(KEY)
    if (s === 'uz' || s === 'ru') return s
  } catch { /* */ }
  return tg?.initDataUnsafe?.user?.language_code === 'ru' ? 'ru' : 'uz'
}

export async function loadLocale(): Promise<void> {
  const l = initial()
  // Zaxira til (uz) ham kerak — ru'da yo'q kalit uz'dan olinadi.
  await Promise.all([ensure(l), l === 'uz' ? null : ensure('uz')])
  i18n.global.locale.value = l
  document.documentElement.lang = l
}

export async function setLocale(l: Locale): Promise<void> {
  await ensure(l)
  try { localStorage.setItem(KEY, l) } catch { /* */ }
  i18n.global.locale.value = l
  document.documentElement.lang = l
}
