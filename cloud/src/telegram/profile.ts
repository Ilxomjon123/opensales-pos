import type { Env } from '../env'
import { tgCall } from './api'
import { trialDays } from '../registry'

// Bot profili (BotFather'dagi "Description", "About", rasm) — /tg/setup orqali kodda, uz (standart) + ru.
// Description — bo'sh chatda ko'rinadi (≤512), short description — profil va ulashilgan havolada (≤120).

export function profileTexts(days: string | undefined) {
  const d = trialDays(days)
  return {
    uz: {
      description: [
        "🧾 OpenSales POS — do'koningiz kassasi endi Telegram ichida.",
        '',
        "⚡️ Tez sotuv: shtrix-kod, savat, naqd / karta / qarz",
        '👥 Mijozlar va qarzlar nazorati',
        "📦 Ombor: kirim, qoldiq, vozvrat",
        '📊 Hisobotlar va Excel',
        "🎙 AI yordamchi: «Bahromga 2 ta zaryadka qarzga» deb ayting — o'zi yozadi",
        "👨‍💼 Kassirlar: har biri o'z smenasi bilan",
        '',
        `🎁 ${d} kun bepul. Boshlash uchun «Start» ni bosing.`,
      ].join('\n'),
      short: `Telegram ichidagi kassa: sotuv, qarz, ombor, hisobot. Ovoz bilan ham ishlaydi. ${d} kun bepul.`,
    },
    ru: {
      description: [
        '🧾 OpenSales POS — касса вашего магазина прямо в Telegram.',
        '',
        '⚡️ Быстрые продажи: штрихкод, корзина, наличные / карта / долг',
        '👥 Клиенты и долги под контролем',
        '📦 Склад: приход, остатки, возвраты',
        '📊 Отчёты и Excel',
        '🎙 AI-помощник: скажите «Бахрому 2 зарядки в долг» — он запишет сам',
        '👨‍💼 Кассиры: у каждого своя смена',
        '',
        `🎁 ${d} дней бесплатно. Нажмите «Start», чтобы начать.`,
      ].join('\n'),
      short: `Касса в Telegram: продажи, долги, склад, отчёты. Работает и голосом. ${d} дней бесплатно.`,
    },
  }
}

/** Description + about (uz standart, ru alohida); `photo` bo'lsa — logo (web/public/bot-logo.jpg, faqat JPG). */
export async function applyProfile(env: Env, opts: { photo: boolean }) {
  const t = profileTexts(env.TRIAL_DAYS)
  const calls = await Promise.all([
    tgCall(env, 'setMyDescription', { description: t.uz.description }),
    tgCall(env, 'setMyDescription', { description: t.ru.description, language_code: 'ru' }),
    tgCall(env, 'setMyShortDescription', { short_description: t.uz.short }),
    tgCall(env, 'setMyShortDescription', { short_description: t.ru.short, language_code: 'ru' }),
  ])
  let photo: boolean | null = null
  if (opts.photo) {
    // Rasm Worker'ning o'z statik fayllaridan (ASSETS) — Telegram'ga multipart, attach:// bilan.
    const res = await env.ASSETS?.fetch(new Request(`${env.APP_URL.replace(/\/+$/, '')}/bot-logo.jpg`)).catch(() => null)
    if (res?.ok) {
      const form = new FormData()
      form.set('photo', JSON.stringify({ type: 'static', photo: 'attach://logo' }))
      form.set('logo', new Blob([await res.arrayBuffer()], { type: 'image/jpeg' }), 'logo.jpg')
      photo = (await tgCall(env, 'setMyProfilePhoto', form)).ok
    } else {
      photo = false
    }
  }
  return { texts: calls.every((c) => c.ok), photo }
}
