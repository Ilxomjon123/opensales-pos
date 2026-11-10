import type { Env } from '../env'

// Bot API chaqiruvi. Qayta urinish YO'Q (at-most-once): timeout'dan keyin qayta yuborish
// foydalanuvchiga ikki xil xabar beradi (backend'dagi saboq). Xato — log va null.

export type TgResult<T> = { ok: true; result: T } | { ok: false; status: number; description: string }

export async function tgCall<T = unknown>(env: Env, method: string, body: Record<string, unknown> | FormData): Promise<TgResult<T>> {
  const base = env.TG_API_BASE || 'https://api.telegram.org'
  const init: RequestInit = body instanceof FormData
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  try {
    const res = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, { ...init, signal: AbortSignal.timeout(15_000) })
    const json = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string } | null
    if (json?.ok) return { ok: true, result: json.result as T }
    const description = json?.description ?? `HTTP ${res.status}`
    console.warn(`tg ${method} failed: ${res.status} ${description}`)
    return { ok: false, status: res.status, description }
  } catch (e) {
    console.warn(`tg ${method} error: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, status: 0, description: 'network' }
  }
}

export function webAppButton(text: string, url: string) {
  return { inline_keyboard: [[{ text, web_app: { url } }]] }
}

/** HTML parse_mode uchun. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
