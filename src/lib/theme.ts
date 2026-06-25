import { ref } from 'vue'

export type Theme = 'system' | 'light' | 'dark'
export const theme = ref<Theme>((localStorage.getItem('theme') as Theme) || 'system')

const mq = window.matchMedia('(prefers-color-scheme: dark)')

function apply() {
  const dark = theme.value === 'dark' || (theme.value === 'system' && mq.matches)
  document.documentElement.classList.toggle('dark', dark)
}

export function setTheme(t: Theme) {
  theme.value = t
  localStorage.setItem('theme', t)
  apply()
}

export function initTheme() {
  apply()
  mq.addEventListener('change', () => { if (theme.value === 'system') apply() })
}
