import { createI18n } from 'vue-i18n'
import { getSetting, setSetting } from './db'
import uz from '../locales/uz'
import ru from '../locales/ru'

export type Locale = 'uz' | 'ru'

export const i18n = createI18n({
  legacy: false,
  locale: 'uz',
  fallbackLocale: 'uz',
  messages: { uz, ru },
})

// Komponentdan tashqari .ts fayllarda ishlatish uchun (lib/*.ts, store, ...).
export const t = i18n.global.t

export const availableLocales = [
  { code: 'uz', label: "O'zbekcha" },
  { code: 'ru', label: 'Русский' },
] as const

// DB'dan saqlangan tilni o'qib o'rnatadi (faqat 'uz' yoki 'ru', aks holda 'uz').
export async function loadLocale(): Promise<void> {
  const saved = await getSetting('locale', 'uz')
  const l: Locale = saved === 'ru' ? 'ru' : 'uz'
  i18n.global.locale.value = l
}

export async function setLocale(l: Locale): Promise<void> {
  await setSetting('locale', l)
  i18n.global.locale.value = l
}
