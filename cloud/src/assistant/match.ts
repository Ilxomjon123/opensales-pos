// AI aytgan nomni (har qanday tilda/yozuvda) do'kon bazasidagi tovar yoki mijozga moslash.
//
// AI hech qachon id bermaydi — u faqat matn ("samsung zaryadka", "Бахром"). Bu yerda deterministik
// tarzda bazadagi yozuvlar bilan solishtiriladi: kirill → lotin, apostroflarsiz, so'zlar bo'yicha
// ball. Raqamli so'zlar (25W, #100, 1kg) aniq mos kelishi shart — "Samsung 25W" ni "Samsung 45W"
// deb tanlab qo'ymaslik uchun. Ishonch past yoki ikki nomzod yaqin bo'lsa — foydalanuvchi tanlaydi.

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 's', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '',
  ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
}

/** Kichik harf, kirill → lotin, apostrof/diakritika yo'q, faqat harf-raqam va bo'shliq. */
export function norm(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase().normalize('NFKD')) out += CYR[ch] ?? ch
  return out
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ʻʼ'`‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** O'zbek lotinidagi sinonim yozuvlar: x/h, q/k, o'/u (kirilldan o'girilganda farq qiladi). */
const soft = (t: string) => t.replace(/x/g, 'h').replace(/q/g, 'k').replace(/yo/g, 'e').replace(/ts/g, 's')

/** Normallashtirilgan so'zlar. */
export const words = (s: string) => norm(s).split(' ').filter(Boolean)
const tokens = words
const hasDigit = (t: string) => /\d/.test(t)

function lev(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (!m || !n) return m || n
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}

/** Bitta so'z juftligining o'xshashligi 0..1. */
function tokenSim(q: string, t: string): number {
  if (q === t) return 1
  if (hasDigit(q) || hasDigit(t)) return q.replace(/\D/g, '') === t.replace(/\D/g, '') && q.replace(/\d/g, '') === t.replace(/\d/g, '') ? 1 : 0
  const a = soft(q), b = soft(t)
  if (a === b) return 0.95
  if (a.length >= 3 && b.startsWith(a)) return 0.85
  if (b.length >= 3 && a.startsWith(b)) return 0.75
  if (a.length >= 4 && b.includes(a)) return 0.6
  const d = lev(a, b)
  const ratio = 1 - d / Math.max(a.length, b.length)
  return ratio >= 0.72 ? ratio * 0.8 : 0
}

/**
 * So'rov va nom o'xshashligi 0..1: so'rovning har so'zi nomdagi eng yaqin so'zga; nomdagi
 * raqamli so'z so'rovda boshqacha bo'lsa — jarima (o'lcham/model farqi).
 */
export function score(query: string, name: string): number {
  const q = tokens(query), n = tokens(name)
  if (!q.length || !n.length) return 0
  if (norm(query) === norm(name)) return 1
  let sum = 0
  for (const qt of q) sum += Math.max(...n.map((nt) => tokenSim(qt, nt)))
  let s = sum / q.length
  const qDigits = q.filter(hasDigit)
  const nDigits = n.filter(hasDigit)
  if (qDigits.length && nDigits.length && !qDigits.some((d) => nDigits.includes(d))) s *= 0.4
  // Nom so'zlarining qanchasi qamralgan — qisqa so'rov uzun nomga juda yuqori ball olmasin.
  const covered = n.filter((nt) => q.some((qt) => tokenSim(qt, nt) >= 0.6)).length / n.length
  return Math.round(s * (0.8 + 0.2 * covered) * 1000) / 1000
}

export type Candidate<T> = { item: T; score: number }

/** Eng yaxshi nomzodlar (ball bo'yicha). `confident` — biri aniq ajralib turibdi. */
export function rank<T>(query: string, items: T[], name: (x: T) => string, opts: { limit?: number; extra?: (x: T) => string | null } = {}) {
  const limit = opts.limit ?? 5
  const scored: Candidate<T>[] = []
  for (const it of items) {
    let s = score(query, name(it))
    const ex = opts.extra?.(it)
    if (ex) s = Math.max(s, score(query, ex))
    if (s > 0.3) scored.push({ item: it, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)
  const [a, b] = top
  const confident = !!a && a.score >= 0.7 && (!b || a.score - b.score >= 0.12 || a.score === 1 && b.score < 1)
  return { top, confident }
}
