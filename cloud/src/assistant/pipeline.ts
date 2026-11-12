import type { Env } from '../env'
import type { Actor } from '../shop/rpc'
import type { Draft, DraftEdits, Source, VoiceMeta } from '../shop/assistant'
import { extract, transcribe, type Extraction, type ShopHints, type Turn } from './ai'
import { DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODEL, GeminiError, geminiAssist } from './gemini'

// Yordamchi quvuri (Worker tomoni): limit/obuna tekshiruvi (DO) → ovoz bo'lsa matnga → LLM →
// DO'da qoralama. Mini app ham, bot ham shuni chaqiradi. AI xatosi foydalanuvchiga tushunarli kod.

/** `more` — shu xabardagi keyingi amallar (har biri alohida karta), bo'lmasa bo'sh. */
export type PipelineResult = { ok: true; draft: Draft; more: Draft[] } | { ok: false; code: string; status: number }

const DEFAULT_DAILY_LIMIT = 150
export const MAX_TEXT = 1000
const MAX_AUDIO = 4_000_000

export type AssistantInput = { text?: string; audio?: Uint8Array; mime?: string }

/**
 * Provayder: Gemini (kalit bo'lsa) — ovoz+tahlil bitta so'rovda, o'zbekcha yaxshi; xato bo'lsa yoki
 * kalit yo'q bo'lsa — Workers AI (Whisper + Llama). Ikkalasiga ham suhbat konteksti beriladi.
 */
export async function runAssistant(env: Env, tenantId: string, actor: Actor, input: AssistantInput, source: Source, chat: { id: string | null; voice: VoiceMeta | null } | null = null, lang: 'uz' | 'ru' = 'uz'): Promise<PipelineResult> {
  if (!env.GEMINI_API_KEY && !env.AI) return { ok: false, code: 'cloud.ai.errors.unavailable', status: 503 }
  const shop = env.SHOP.getByName(tenantId)
  const limit = Number(env.AI_DAILY_LIMIT) > 0 ? Number(env.AI_DAILY_LIMIT) : DEFAULT_DAILY_LIMIT
  const begin = (await shop.assistantBegin(actor, limit, chat ? chat.id ?? '' : null)) as { ok: true; hints: ShopHints; history: Turn[] } | { ok: false; code: string; status: number }
  if (!begin.ok) return begin
  const hints: ShopHints = { ...begin.hints, lang }
  const text = (input.text ?? '').trim().slice(0, MAX_TEXT)
  if (!text && !input.audio) return { ok: false, code: 'cloud.ai.errors.emptySpeech', status: 422 }
  if (input.audio && input.audio.byteLength > MAX_AUDIO) return { ok: false, code: 'cloud.ai.errors.audioTooLong', status: 413 }

  let transcript = text
  let extraction: Extraction | null = null
  let engine = 'gemini'
  if (env.GEMINI_API_KEY) {
    // Asosiy model kvotasi tugasa (bepul tarif: kuniga ~20 so'rov) yoki vaqtincha ishlamasa — zaxira Gemini
    // modeli (alohida kvota), shundan keyingina Workers AI (o'zbekchani ancha yomon tushunadi).
    const models = [env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL ?? FALLBACK_GEMINI_MODEL]
      .filter((m, i, a) => !!m && a.indexOf(m) === i)
    for (const model of models) {
      try {
        const g = await geminiAssist({
          key: env.GEMINI_API_KEY, model, hints, history: begin.history,
          text: text || undefined, audio: !text && input.audio ? { bytes: input.audio, mime: input.mime ?? 'audio/ogg' } : undefined,
        })
        extraction = g.extraction
        if (!text) transcript = g.transcript
        engine = `gemini:${model}`
        break
      } catch (e) {
        console.warn(`assistant gemini ${model}:`, e instanceof GeminiError ? `${e.status} ${e.message.slice(0, 160)}` : e instanceof Error ? e.message : String(e))
        if (!(e instanceof GeminiError && (e.status === 429 || e.status >= 500))) break
      }
    }
  }
  if (!extraction && env.AI) {
    engine = 'workers-ai'
    if (!transcript && input.audio) {
      try {
        transcript = await transcribe(env.AI, input.audio, hints)
      } catch (e) {
        console.warn('assistant stt:', e instanceof Error ? e.message : String(e))
        return { ok: false, code: e instanceof Error && e.message === 'audioSize' ? 'cloud.ai.errors.audioTooLong' : 'cloud.ai.errors.stt', status: 502 }
      }
    }
    if (transcript) {
      try {
        extraction = await extract(env.AI, transcript, hints, begin.history)
      } catch (e) {
        console.warn('assistant llm:', e instanceof Error ? e.message : String(e))
        return { ok: false, code: 'cloud.ai.errors.llm', status: 502 }
      }
    }
  }
  if (!transcript && input.audio) return { ok: false, code: extraction ? 'cloud.ai.errors.emptySpeech' : 'cloud.ai.errors.stt', status: 422 }
  if (!extraction) return { ok: false, code: 'cloud.ai.errors.llm', status: 502 }
  const res = (await shop.assistantDraft(actor, transcript, source, extraction, chat, lang)) as (Draft & { more: Draft[] }) | null
  if (!res) return { ok: false, code: 'cloud.errors.memberRevoked', status: 403 }
  const { more, ...draft } = res
  console.log(`assistant ${engine}: ${[draft, ...more].map((d) => `${d.kind} ready=${d.ready}`).join(', ')}`)
  return { ok: true, draft, more: more ?? [] }
}

const posNum = (v: unknown, max = 1e12): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null)
const optStr = (v: unknown, max: number): string | null | undefined => (v === null ? null : typeof v === 'string' ? v.trim().slice(0, max) || null : undefined)

/** Klientdan kelgan tuzatishlar — faqat ma'lum maydonlar, to'g'ri turlar (qolgani e'tiborsiz). */
export function cleanEdits(raw: unknown): DraftEdits {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const e: DraftEdits = {}
  if (o.customerId === null || (typeof o.customerId === 'number' && Number.isSafeInteger(o.customerId) && o.customerId > 0)) e.customerId = o.customerId as number | null
  if (Array.isArray(o.items)) {
    e.items = o.items.slice(0, 50).flatMap((it) => {
      const r = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
      const productId = typeof r.productId === 'number' && Number.isSafeInteger(r.productId) && r.productId > 0 ? r.productId : null
      const qty = posNum(r.qty, 1e6)
      if (!productId || !qty) return []
      return [{ productId, qty, price: r.price === null ? null : posNum(r.price) ?? undefined }]
    })
  }
  if (Array.isArray(o.newItems)) {
    e.newItems = o.newItems.slice(0, 50).flatMap((it) => {
      const r = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
      const name = typeof r.name === 'string' ? r.name.trim().slice(0, 200) : ''
      if (!name) return []
      const unit = typeof r.unit === 'string' ? r.unit.trim().slice(0, 20) || null : null
      return [{ name, price: posNum(r.price), cost: posNum(r.cost), unit, qty: posNum(r.qty, 1e9) ?? 0 }]
    })
  }
  if (Array.isArray(o.people)) {
    e.people = o.people.slice(0, 30).flatMap((it) => {
      const r = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
      const name = typeof r.name === 'string' ? r.name.trim().slice(0, 200) : ''
      if (!name) return []
      const kind = r.kind === 'debt' || r.kind === 'credit' ? r.kind : 'none'
      return [{ name, phone: typeof r.phone === 'string' ? r.phone.trim().slice(0, 40) || null : null, kind, amount: posNum(r.amount) }]
    })
  }
  if (typeof o.rate === 'number' && Number.isFinite(o.rate) && o.rate > 0 && o.rate <= 1e7) e.rate = o.rate
  if (o.newCustomer === null || typeof o.newCustomer === 'string') e.newCustomer = o.newCustomer === null ? null : String(o.newCustomer).trim().slice(0, 120) || null
  if (o.method === 'cash' || o.method === 'card' || o.method === 'debt' || o.method === 'transfer') e.method = o.method
  if (o.paid === null || posNum(o.paid) !== null) e.paid = o.paid as number | null
  if (o.amount === null || posNum(o.amount) !== null) e.amount = o.amount as number | null
  for (const k of ['category', 'supplier', 'note'] as const) {
    const v = optStr(o[k], k === 'note' ? 300 : 120)
    if (v !== undefined) e[k] = v
  }
  return e
}
