import { ref } from 'vue'

// Keng ekran (≥1024px, Tailwind `lg`) — jadval; tor (telefon) — kartalar ro'yxati.
// Ikkalasini birdan chizib CSS bilan yashirish telefonda sahifa ochilishini sekinlatardi
// (Mahsulotlar: 80 qator × 2). Desktop oynasi minWidth 1024 — u yerda doim true.
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(min-width: 1024px)') : null
const wide = ref(mq?.matches ?? true)
mq?.addEventListener?.('change', (e) => { wide.value = e.matches })

export function useWide() {
  return wide
}
