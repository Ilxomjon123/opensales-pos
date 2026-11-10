import { ref } from 'vue'
import { tg, paintChrome } from '../telegram'

// Desktop theme.ts o'rniga: mavzu Telegram'nikiga ergashadi — yorug'/qorong'i VA ranglar (themeParams):
// sahifa foni, karta, matn, izoh, tugma, ajratgich. Foydalanuvchi Telegram mavzusini o'zgartirsa — jonli
// yangilanadi (themeChanged). Telegram tashqarisida (lokal dev) — style.css dagi o'z palitramiz.
export type Theme = 'system' | 'light' | 'dark'
export const theme = ref<Theme>('system')

function systemDark(): boolean {
  if (tg) return tg.colorScheme === 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Ilova tokenlari, ular Telegram ranglaridan to'ldiriladi (inline — style.css dagi qiymatlardan ustun). */
const VARS = [
  '--background', '--foreground', '--card', '--card-foreground', '--popover', '--popover-foreground',
  '--primary', '--primary-foreground', '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
  '--accent', '--accent-foreground', '--destructive', '--border', '--input', '--ring',
  '--glass-tint', '--on-tint', '--glass-strong', '--glow-a', '--glow-b', '--glow-c',
]
const hex = (v: string | undefined) => (v && /^#[0-9a-f]{3,8}$/i.test(v) ? v : undefined)

/** Telegram ranglarini qo'llaydi; sahifa fonini qaytaradi (sarlavha/pastki panel uchun) yoki null. */
export function applyTelegramColors(p: Record<string, string> | undefined = tg?.themeParams): string | null {
  const st = document.documentElement.style
  const bg = hex(p?.secondary_bg_color) ?? hex(p?.bg_color)
  const text = hex(p?.text_color)
  if (theme.value !== 'system' || !bg || !text) {
    for (const v of VARS) st.removeProperty(v)
    return null
  }
  // Telegram'ning "guruhlangan ro'yxat" uslubi: sahifa — secondary_bg, bo'limlar (kartalar) — section_bg/bg.
  const card = hex(p?.section_bg_color) ?? hex(p?.bg_color) ?? bg
  const hint = hex(p?.hint_color) ?? hex(p?.subtitle_text_color) ?? `color-mix(in srgb, ${text} 55%, ${card})`
  const btn = hex(p?.button_color) ?? hex(p?.accent_text_color) ?? text
  const onBtn = hex(p?.button_text_color) ?? '#ffffff'
  const sep = hex(p?.section_separator_color) ?? `color-mix(in srgb, ${text} 10%, transparent)`
  const set = (k: string, v: string) => st.setProperty(k, v)
  set('--background', bg)
  set('--foreground', text)
  set('--card', card)
  set('--card-foreground', text)
  set('--popover', card)
  set('--popover-foreground', text)
  set('--primary', btn)
  set('--primary-foreground', onBtn)
  set('--secondary', `color-mix(in srgb, ${text} 8%, ${card})`)
  set('--secondary-foreground', text)
  set('--muted', `color-mix(in srgb, ${text} 6%, ${card})`)
  set('--muted-foreground', hint)
  set('--accent', `color-mix(in srgb, ${text} 6%, transparent)`)
  set('--accent-foreground', text)
  set('--destructive', hex(p?.destructive_text_color) ?? '#e53935')
  set('--border', sep)
  set('--input', `color-mix(in srgb, ${text} 12%, transparent)`)
  set('--ring', btn)
  // Shisha: faol/to'ldirilgan tugmalar — Telegram tugma rangi; suzuvchi qatlamlar — karta rangidan.
  set('--glass-tint', btn)
  set('--on-tint', onBtn)
  set('--glass-strong', `color-mix(in srgb, ${card} 80%, transparent)`)
  set('--glow-a', `color-mix(in srgb, ${btn} 14%, transparent)`)
  set('--glow-b', 'transparent')
  set('--glow-c', `color-mix(in srgb, ${btn} 8%, transparent)`)
  return bg
}

function apply() {
  const dark = theme.value === 'dark' || (theme.value === 'system' && systemDark())
  document.documentElement.classList.toggle('dark', dark)
  paintChrome(dark, applyTelegramColors())
}

export function setTheme(t: Theme) {
  theme.value = t
  apply()
}

export function initTheme() {
  apply()
  tg?.onEvent('themeChanged', apply)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply)
}
