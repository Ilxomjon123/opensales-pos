import { SCHEMA, parseLoose, sanitize, systemPrompt, type Extraction, type ShopHints, type Turn } from './ai'

// Gemini (Google AI Studio REST): ovozni ham, matnni ham BITTA so'rovda tushunadi — o'zbekcha nutqni
// Whisper'dan ancha yaxshi taniydi. Javob: transkripsiya + amal(lar) (ai.ts dagi bir xil sxema).
// Xato bo'lsa (kalit, limit, region, format) — chaqiruvchi Workers AI'ga o'tadi (pipeline.ts).

// 2026-11-08 prod o'lchovi: 3.5-flash 1,7 s (to'g'ri); 3.8-flash va flash-latest 30 s da javobsiz; 2.5 yangilarga yopiq.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash'
/** Zaxira: alohida bepul kvota, tez; 2026-11-08 sinovida tuzatish ssenariylarini to'g'ri yechdi. */
export const FALLBACK_GEMINI_MODEL = 'gemini-3.5-flash-lite'
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

const SCHEMA_WITH_TRANSCRIPT = {
  ...SCHEMA,
  properties: { transcript: { type: 'string' }, ...SCHEMA.properties },
  required: ['transcript', ...SCHEMA.required],
}

export class GeminiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(bin)
}

/** Brauzer/Telegram MIME → Gemini qabul qiladigan audio turi. */
export function audioMime(type: string | null | undefined): string {
  const t = (type ?? '').split(';')[0].trim().toLowerCase()
  if (t === 'audio/oga' || t === 'audio/opus' || t === 'application/ogg') return 'audio/ogg'
  if (t === 'audio/x-m4a' || t === 'audio/m4a') return 'audio/mp4'
  return t || 'audio/ogg'
}

type Part = { text: string } | { inlineData: { mimeType: string; data: string } }

export async function geminiAssist(p: {
  key: string
  model?: string
  hints: ShopHints
  history: Turn[]
  text?: string
  audio?: { bytes: Uint8Array; mime: string }
  fetcher?: typeof fetch
}): Promise<{ transcript: string; extraction: Extraction }> {
  const model = p.model || DEFAULT_GEMINI_MODEL
  const system = systemPrompt(p.hints) + '\n' + [
    'Also return "transcript": the current message exactly as the user said or wrote it, in its original language and script.',
    'For a voice message, transcribe faithfully (Uzbek may be in Latin or Cyrillic; write it the way an Uzbek speaker would, Latin by default). Do not translate.',
    'Write every number and model name exactly as heard (e.g. "iPhone o\'n sakkiz Pro Max" → "iPhone 18 Pro Max"). Never replace a model you do not know with one you know.',
  ].join('\n')
  const contents: { role: 'user' | 'model'; parts: Part[] }[] = p.history.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text.slice(0, 1500) }] }))
  const current: Part[] = p.audio
    ? [{ inlineData: { mimeType: audioMime(p.audio.mime), data: toBase64(p.audio.bytes) } }, { text: 'Voice message from the shopkeeper: transcribe it and extract the action.' }]
    : [{ text: (p.text ?? '').slice(0, 1500) }]
  contents.push({ role: 'user', parts: current })

  const call = async (strict: boolean) => {
    const generationConfig: Record<string, unknown> = { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 2500 }
    if (strict) {
      generationConfig.responseJsonSchema = SCHEMA_WITH_TRANSCRIPT
      // Tezlik: "o'ylash" eng kam. Gemini 3+ — thinkingLevel, 2.5 — thinkingBudget.
      generationConfig.thinkingConfig = /gemini-(2\.|1\.)/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'minimal' }
    }
    const res = await (p.fetcher ?? fetch)(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await res.json().catch(() => null)) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
      error?: { message?: string }
    } | null
    if (!res.ok) throw new GeminiError(res.status, json?.error?.message ?? `HTTP ${res.status}`)
    const text = (json?.candidates?.[0]?.content?.parts ?? []).map((x) => x.text ?? '').join('')
    if (!text) throw new GeminiError(502, 'empty response')
    return text
  }

  let text: string
  try {
    text = await call(true)
  } catch (e) {
    // Eski/boshqa model sxema yoki "thinking" sozlamasini qabul qilmasa — oddiy JSON rejimida qayta.
    if (e instanceof GeminiError && e.status === 400 && !/inline|audio|mime/i.test(e.message)) text = await call(false)
    else throw e
  }
  const raw = parseLoose(text) as Record<string, unknown> | null
  const transcript = typeof raw?.transcript === 'string' ? raw.transcript.trim().slice(0, 1500) : ''
  return { transcript, extraction: sanitize(raw) }
}
