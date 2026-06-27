// Skaner tovushlari — WebAudio orqali (fayl kerak emas, offline ishlaydi).
// beepOk: tovar tanilди (qisqa baland "tit"). beepFail: tanilmadi (past, ikki marta rad).
let ctx: AudioContext | null = null
function ac(): AudioContext | null {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    if (ctx.state === 'suspended') ctx.resume()
    return ctx
  } catch { return null }
}

// AudioContext'ni foydalanuvchi harakatида oldindan ochish (1-tovush kechikmasin).
export function unlockAudio() { ac() }

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'square', gain = 0.3) {
  const c = ac()
  if (!c) return
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.value = freq
  // suspended holatда currentTime to'xtab qolishi mumkin — kichik lookahead beramiz.
  const t0 = c.currentTime + 0.02 + start
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008)
  g.gain.setValueAtTime(gain, t0 + dur - 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(g).connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.02)
}

// Tovar tanilди — bitta qisqa baland signal.
export function beepOk() { tone(1800, 0, 0.1, 'square', 0.25) }
// Tovar tanilmadi — past "buzz" + ikki marta tushuvchi (xato), balandroq.
export function beepFail() {
  tone(220, 0, 0.18, 'square', 0.35)
  tone(160, 0.2, 0.28, 'square', 0.35)
}
