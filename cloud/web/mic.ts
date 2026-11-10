// Mikrofon oqimi — yordamchi ochiq turganda BITTA marta olinadi va yozuvlar orasida qayta ishlatiladi.
// Sabab: Telegram (Android) har getUserMedia chaqiruvida o'z ruxsat oynasini chiqaradi — har yozuvdan keyin
// oqimni to'xtatsak, keyingi bosishda yana so'raladi. Varaq yopilgach qisqa muddatdan keyin, ilova fonga
// o'tsa — darhol bo'shatiladi (mikrofon keraksiz band turmasin).

let cached: MediaStream | null = null
let pending: Promise<MediaStream> | null = null
let releaseTimer = 0

const live = (s: MediaStream | null) => !!s && s.getAudioTracks().some((t) => t.readyState === 'live')

export async function acquireMic(): Promise<MediaStream> {
  clearTimeout(releaseTimer)
  if (live(cached)) return cached!
  // Ikki marta tez bosilsa — bitta so'rov (ikkita ruxsat oynasi chiqmasin).
  pending ??= navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then((s) => (cached = s))
    .finally(() => { pending = null })
  return pending
}

export function micReady(): boolean {
  return live(cached)
}

export function releaseMic() {
  clearTimeout(releaseTimer)
  cached?.getTracks().forEach((t) => t.stop())
  cached = null
}

/** Varaq yopildi — biroz kutib bo'shatamiz (darhol qayta ochilsa yana so'ralmasin). */
export function releaseMicSoon(ms = 60_000) {
  clearTimeout(releaseTimer)
  releaseTimer = window.setTimeout(releaseMic, ms)
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseMic() })
}
