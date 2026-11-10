import { reactive } from 'vue'
import { bumpData } from './freshness'

// Yordamchi varag'ining umumiy holati: istalgan joydan ochiladi (suzuvchi tugma, bot kartasidagi
// "Ilovada ochish" → ?draft=<id>). Yozuv saqlangach `version` oshadi — ochiq sahifa qayta yuklanadi.
export const assistant = reactive({
  open: false,
  draftId: null as string | null,
  version: 0,
  /** Ochiq yordamchining "orqaga" amali (tahrir → chat → chatlar ro'yxati → yopish) — Telegram BackButton uchun. */
  back: null as (() => void) | null,
})

export function openAssistant(draftId: string | null = null) {
  assistant.draftId = draftId
  assistant.open = true
}

export function assistantSaved() {
  assistant.version++
  bumpData()
}
