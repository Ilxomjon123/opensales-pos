import type { ShopDO } from './shop/ShopDO'
import type { AiRunner } from './assistant/ai'

export interface Env {
  SHOP: DurableObjectNamespace<ShopDO>
  DB: D1Database
  ASSETS: Fetcher

  // Secrets (wrangler secret put / .dev.vars)
  BOT_TOKEN: string
  SESSION_KEY: string
  TG_WEBHOOK_SECRET: string

  // Vars
  BOT_USERNAME: string
  /** Mini app manzili (web_app tugma) — masalan https://kassa.opensales.uz */
  APP_URL: string
  /** Yangi do'konlar haqida xabar va admin buyruqlari (Ilxomjon). */
  ADMIN_CHAT_ID: string
  TRIAL_DAYS: string
  /** Testlarda Telegram API o'rniga soxta server. */
  TG_API_BASE?: string
  /** Workers AI (yordamchi: ovoz→matn, matn→amal). Yo'q bo'lsa yordamchi o'chiq (503). */
  AI?: AiRunner
  /** Gemini (Google AI Studio) kaliti — bo'lsa yordamchi asosan Gemini'da (o'zbekcha ovoz yaxshi). Secret. */
  GEMINI_API_KEY?: string
  /** Gemini modeli (standart gemini-2.5-flash). */
  GEMINI_MODEL?: string
  /** Asosiy model kvota/xato (429, 5xx) bersa — shu model (standart: gemini-3.5-flash-lite), keyin Workers AI. */
  GEMINI_FALLBACK_MODEL?: string
  /** Do'kon boshiga kunlik AI chaqiruvlari (standart 150). */
  AI_DAILY_LIMIT?: string
  /** Obuna/to'lov bo'yicha yoziladigan Telegram username (@siz). Bo'sh bo'lsa sinov tugashi eslatmasi yuborilmaydi. */
  SUPPORT_USERNAME?: string
}
