// Rust `f64::round` — yarmi noldan uzoqqa (−2.5 → −3). JS Math.round esa +∞ tomonga
// (−2.5 → −2). Rust'dan ko'chirilgan formulalar shu bilan yaxlitlaydi.
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x)
}

/** Miqdor 3 xona aniqlikda (gramm). */
export const QTY_SCALE = 1000
export const QTY_EPS = 1e-6

export function normalizeQty(q: number): number {
  return roundHalfAway(q * QTY_SCALE) / QTY_SCALE
}

/** Pul yig'indilarini (INTEGER ustun, lekin eski yozuvda kasr) Rust'dagi CAST(ROUND()) kabi. */
export function intMoney(x: unknown): number {
  const n = typeof x === 'number' ? x : Number(x ?? 0)
  return Number.isFinite(n) ? roundHalfAway(n) : 0
}

/**
 * `total` ning `part / whole` ulushi, butun so'mda (yarmi yuqoriga). `part == whole` bo'lsa
 * aynan `total`. Rust'da i128 — bu yerda BigInt (total*part 2^53 dan oshishi mumkin).
 */
export function allocate(total: number, part: number, whole: number): number {
  if (whole <= 0 || part <= 0) return 0
  if (part >= whole) return total
  const t = BigInt(total), p = BigInt(part), w = BigInt(whole)
  const num = t * p * 2n + w
  const den = 2n * w
  // Rust i128 bo'lishi noldan tomonga kesadi; total manfiy bo'lmaydi (max(0) dan keyin).
  return Number(num / den)
}
