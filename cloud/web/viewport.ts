// Ilova balandligi (`--app-h`). Asos — WebView'ning haqiqiy balandligi (`window.innerHeight`).
// Telegram'ning `viewportStableHeight` qiymatiga to'liq ishonib bo'lmaydi: 2026-11-09 Android'da chek ulashish
// oynasi (shareMessage) ochilganda Telegram uni oyna ustidagi bo'lakka (~60px) tushirdi va yopilganda qaytarmadi —
// ilova sarlavha balandligida kesilib, Sotuvlar ro'yxati qora qoldi. Telegram qiymati faqat klaviatura ochiq
// (matn maydoni fokusda) paytda kerak — iOS WebView klaviaturada o'z balandligini kichraytirmaydi.

/** Klaviatura ochiq bo'lishi mumkin bo'lgan holatda ham juda kichik (qotib qolgan) Telegram balandligi rad etiladi. */
export const MIN_KEYBOARD_SHARE = 0.35

export function appHeight(inner: number, tgStable: number | null | undefined, typing: boolean): number {
  if (!(inner > 0)) return tgStable && tgStable > 0 ? tgStable : 0
  if (typing && tgStable && tgStable < inner && tgStable >= inner * MIN_KEYBOARD_SHARE) return tgStable
  return inner
}

/** DOM tiplarisiz (worker tsconfig ham tekshiradi): faqat kerakli maydonlar. */
type FocusLike = { tagName: string; isContentEditable?: boolean; type?: string }

export function isTyping(el: FocusLike | null): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  const type = (el.type || 'text').toLowerCase()
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden'].includes(type)
}
