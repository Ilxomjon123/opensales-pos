import { ref } from 'vue'

export const currencySymbol = ref("so'm")

export function setCurrency(sym: string) {
  if (sym) currencySymbol.value = sym
}

export function money(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

export function moneySum(n: number): string {
  return money(n) + ' ' + currencySymbol.value
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Kirill <-> lotin qidiruv (alifbodan qat'i nazar)
const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ғ: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z',
  и: 'i', й: 'y', к: 'k', қ: 'q', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ў: 'o', ф: 'f', х: 'x', ҳ: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
}
function key(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) out += CYR[ch] ?? ch
  return out.replace(/[ʻʼ'`‘’]/g, '')
}
export function translitMatch(text: string, query: string): boolean {
  const q = key(query.trim())
  return q === '' ? true : key(text).includes(q)
}
