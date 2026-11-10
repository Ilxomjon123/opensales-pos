import { tg } from '../telegram'
import type { Platform } from '@tauri-apps/plugin-os'

// Desktop platform.ts (plugin-os) o'rniga — Telegram klient platformasi.
const p = tg?.platform ?? 'web'
// Tur desktop bilan bir xil (Platform); Telegram web/desktop klienti — 'linux' deb olinadi
// (kamera sozlamalari tugmasi — Tauri buyrug'i — bulutda chiqmasin).
export const currentPlatform: Platform = p === 'android' || p === 'android_x' ? 'android' : p === 'ios' ? 'ios' : 'linux'
export const isAndroid = currentPlatform === 'android'
export const isIOS = currentPlatform === 'ios'
export const isMobile = isAndroid || isIOS
export const isDesktop = !isMobile
