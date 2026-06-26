import { platform } from '@tauri-apps/plugin-os'

// Joriy OS. plugin-os v2 da sinxron qiymat qaytaradi.
export const currentPlatform = platform()

export const isAndroid = currentPlatform === 'android'
export const isIOS = currentPlatform === 'ios'
export const isMobile = isAndroid || isIOS
export const isDesktop = !isMobile
