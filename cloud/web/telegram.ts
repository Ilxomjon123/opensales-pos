// Telegram WebApp SDK (telegram-web-app.js index.html'da). Brauzerda (Telegram'siz) `tg` null.
import { appHeight, isTyping } from './viewport'

type BackButton = { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void }
type HapticFeedback = { impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void; notificationOccurred(t: 'error' | 'success' | 'warning'): void; selectionChanged(): void }

export type TelegramWebApp = {
  initData: string
  initDataUnsafe: { user?: { id: number; first_name?: string; language_code?: string }; start_param?: string }
  version: string
  platform: string
  colorScheme: 'light' | 'dark'
  themeParams: Record<string, string>
  isVersionAtLeast(v: string): boolean
  viewportStableHeight?: number
  ready(): void
  expand(): void
  close(): void
  disableVerticalSwipes?(): void
  setHeaderColor?(c: string): void
  setBackgroundColor?(c: string): void
  setBottomBarColor?(c: string): void
  onEvent(e: string, cb: () => void): void
  openTelegramLink(url: string): void
  openLink(url: string): void
  /** Bot API 8.0: tayyorlangan xabarni ulashish (chat tanlash oynasi). */
  shareMessage?(id: string, cb?: (sent: boolean) => void): void
  showAlert?(msg: string): void
  BackButton: BackButton
  HapticFeedback?: HapticFeedback
}

declare global {
  interface Window { Telegram?: { WebApp?: TelegramWebApp } }
}

export const tg: TelegramWebApp | null = (() => {
  const w = window.Telegram?.WebApp
  // SDK brauzerda ham yuklanadi, lekin initData bo'sh — Telegram ichida emasmiz.
  return w && (w.initData || w.platform !== 'unknown') ? w : null
})()

export function insideTelegram(): boolean {
  return !!tg?.initData
}

export function atLeast(v: string): boolean {
  return !!tg?.isVersionAtLeast?.(v)
}

/**
 * Android WebView (Telegram ichida): ilova fonga ketib qaytganda GPU qatlamlari ba'zan qayta chizilmaydi —
 * ekran qora, sahifadan bo'laklar va yashirin varaq (savat) qismlari noto'g'ri joyda (2026-11-09 user skrinshoti).
 * Qaytishda butun sahifaga bir necha kadr yangi kompozitsiya beramiz — brauzer hammasini qaytadan chizadi.
 */
let repaintPending = false
/** Butun sahifaga bir necha kadr yangi kompozitsiya — WebView hammasini qaytadan chizadi. */
export function repaint() {
  if (document.hidden || repaintPending) return
  repaintPending = true
  const root = document.documentElement
  requestAnimationFrame(() => {
    root.classList.add('os-repaint')
    void root.offsetHeight
    requestAnimationFrame(() => requestAnimationFrame(() => {
      root.classList.remove('os-repaint')
      repaintPending = false
    }))
  })
}

/**
 * Telegram'ning tizim oynasi (chek ulashish, QR skaner, popup) yopilgandan keyin ham shunday: 2026-11-09
 * chekni ulashib qaytganda Sotuvlar ro'yxati qora qoldi. Oyna yopilish animatsiyasi tugashini ham kutamiz.
 */
export function repaintAfterOverlay() {
  repaint()
  setTimeout(repaint, 400)
}

export function repaintOnResume() {
  const kick = () => repaint()
  document.addEventListener('visibilitychange', kick)
  window.addEventListener('pageshow', kick)
  window.addEventListener('focus', kick)
  if (!tg) return
  // Bot API 8.0: mini app yana faol bo'ldi (yig'ilgan holatdan ochildi).
  if (atLeast('8.0')) {
    tg.onEvent('activated', repaintAfterOverlay)
    tg.onEvent('shareMessageSent', repaintAfterOverlay)
    tg.onEvent('shareMessageFailed', repaintAfterOverlay)
  }
  tg.onEvent('popupClosed', repaintAfterOverlay)
  tg.onEvent('scanQrPopupClosed', repaintAfterOverlay)
}

/** `--app-h` ni haqiqiy WebView balandligidan yangilab turadi (sabab — viewport.ts). */
export function syncAppHeight() {
  const root = document.documentElement
  let raf = 0
  const apply = () => {
    raf = 0
    const h = appHeight(window.innerHeight, tg?.viewportStableHeight, isTyping(document.activeElement))
    if (h > 0) root.style.setProperty('--app-h', `${Math.round(h)}px`)
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply) }
  apply()
  window.addEventListener('resize', schedule)
  window.visualViewport?.addEventListener('resize', schedule)
  window.addEventListener('pageshow', schedule)
  document.addEventListener('visibilitychange', schedule)
  document.addEventListener('focusin', schedule)
  // Fokus chiqqanda klaviatura yopilish animatsiyasi tugashini ham kutamiz.
  document.addEventListener('focusout', () => { schedule(); setTimeout(schedule, 350) })
  if (!tg) return
  tg.onEvent('viewportChanged', schedule)
  for (const e of ['activated', 'shareMessageSent', 'shareMessageFailed', 'popupClosed', 'scanQrPopupClosed']) {
    tg.onEvent(e, () => { schedule(); setTimeout(schedule, 400) })
  }
}

/** Ilova tayyor: to'liq balandlik, pastga tortib yopish o'chiq (kassada ro'yxat aylantiriladi). */
export function initTelegram() {
  repaintOnResume()
  syncAppHeight()
  if (!tg) return
  tg.ready()
  tg.expand()
  if (atLeast('7.7')) tg.disableVerticalSwipes?.()
}

/** Telegram fon/sarlavha ranglari ilova foniga mos (Telegram mavzusi rangi bo'lsa — o'sha). */
export function paintChrome(dark: boolean, pageBg: string | null = null) {
  if (!tg || !atLeast('6.1')) return
  const bg = pageBg ?? (dark ? '#0a0a0a' : '#ffffff')
  try {
    tg.setHeaderColor?.(bg)
    tg.setBackgroundColor?.(bg)
    if (atLeast('7.10')) tg.setBottomBarColor?.(bg)
  } catch { /* eski klient */ }
}

export function haptic(kind: 'light' | 'select' | 'success' | 'error') {
  const h = tg?.HapticFeedback
  if (!h || !atLeast('6.1')) return
  if (kind === 'select') h.selectionChanged()
  else if (kind === 'light') h.impactOccurred('light')
  else h.notificationOccurred(kind)
}

let backHandler: (() => void) | null = null
export function setBackButton(visible: boolean, onClick: () => void) {
  if (!tg || !atLeast('6.1')) return
  if (backHandler) tg.BackButton.offClick(backHandler)
  backHandler = null
  if (visible) {
    backHandler = onClick
    tg.BackButton.onClick(onClick)
    tg.BackButton.show()
  } else {
    tg.BackButton.hide()
  }
}

export function openTelegramLink(url: string) {
  if (tg) tg.openTelegramLink(url)
  else window.open(url, '_blank')
}

/** Botning o'z chatiga qaytish: havola shu chatni ochadi (ilova boshqa joydan ochilgan bo'lsa), keyin ilova
 *  yopiladi — ilova o'sha chat ustida ochiq bo'lsa, havolaning o'zi ko'rinmas edi ("hech narsa bo'lmaydi"). */
export function goToBotChat(bot: string) {
  if (!tg) { window.open(`https://t.me/${bot}`, '_blank'); return }
  tg.openTelegramLink(`https://t.me/${bot}`)
  setTimeout(() => tg.close(), 250)
}
