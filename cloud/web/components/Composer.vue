<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Mic, ArrowUp, Lock, ChevronUp, ChevronLeft, Trash2 } from 'lucide-vue-next'
import { haptic } from '../telegram'
import { acquireMic, releaseMicSoon } from '../mic'

// Telegram'dagi kabi xabar paneli: chapda maydon, o'ngda mikrofon — matn yozilsa yuborish
// tugmasiga aylanadi. Ovoz: mikrofonni BOSIB TURING → yoziladi; qo'yib yuborsangiz — yuboriladi;
// chapga suring — bekor; yuqoriga suring — qulf (qo'lsiz yozish, keyin ↑ bilan yuborish).
// Katta doira ovoz balandligiga qarab "nafas oladi", qizil nuqta miltillaydi, taymer o'nliklar bilan.

const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{
  text: [value: string]
  voice: [v: { blob: Blob; type: string; ms: number; wave: number[] }]
  error: [code: 'denied' | 'unsupported']
}>()
const { t } = useI18n()

const text = ref('')
const field = ref<HTMLTextAreaElement | null>(null)
const hasText = computed(() => text.value.trim().length > 0)

type State = 'idle' | 'recording' | 'locked'
const state = ref<State>('idle')
const isRec = computed(() => state.value !== 'idle')
const ms = ref(0)
const level = ref(0)
const dx = ref(0)
const dy = ref(0)
const hint = ref(false)
/** Ruxsat endigina berildi (barmoq ruxsat oynasida qo'yib yuborilgan) — "endi bosib turing". */
const readyHint = ref(false)
const cancelling = ref(false)

const CANCEL_X = -110
const LOCK_Y = -90
const MAX_MS = 60_000

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let audioCtx: AudioContext | null = null
let raf = 0
let startedAt = 0
let wave: number[] = []
let lastWaveAt = 0
let discard = false
let pointerId: number | null = null
let startX = 0
let startY = 0
let downAt = 0
let hintTimer = 0

function autosize() {
  const el = field.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`
}

function sendText() {
  const v = text.value.trim()
  if (!v || props.disabled) return
  emit('text', v)
  text.value = ''
  nextTick(autosize)
  haptic('light')
}

// ---- Ovoz yozish ---------------------------------------------------------------------------

async function begin(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { emit('error', 'unsupported'); return false }
  try {
    stream = await acquireMic()
  } catch (e) {
    emit('error', (e as DOMException)?.name === 'NotAllowedError' ? 'denied' : 'unsupported')
    return false
  }
  // Ruxsat so'ralayotganda barmoq qo'yib yuborilgan (Telegram oynasi bosishni uzadi) — yozmaymiz, lekin
  // oqim saqlanadi: keyingi bosishda ruxsat oynasi chiqmaydi, darhol yoziladi.
  if (!isRec.value) {
    stream = null
    hint.value = false
    readyHint.value = true
    clearTimeout(hintTimer)
    hintTimer = window.setTimeout(() => { readyHint.value = false }, 2600)
    return false
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported?.(m))
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined)
  chunks = []
  wave = []
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  recorder.onstop = finished
  recorder.start(250)
  startedAt = performance.now()
  meter()
  return true
}

/** Ovoz balandligi (0..1) — katta doira va to'lqin uchun. */
function meter() {
  try {
    audioCtx = new AudioContext()
    const src = audioCtx.createMediaStreamSource(stream!)
    const an = audioCtx.createAnalyser()
    an.fftSize = 512
    src.connect(an)
    const buf = new Uint8Array(an.fftSize)
    const tick = () => {
      an.getByteTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += ((v - 128) / 128) ** 2
      const rms = Math.sqrt(sum / buf.length)
      level.value = level.value * 0.6 + Math.min(1, rms * 4) * 0.4
      const now = performance.now()
      ms.value = now - startedAt
      if (now - lastWaveAt > 90) { wave.push(level.value); lastWaveAt = now }
      if (ms.value >= MAX_MS) { finish(); return }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  } catch {
    // AudioContext yo'q — vaqt baribir sanaladi.
    const tick = () => { ms.value = performance.now() - startedAt; if (ms.value >= MAX_MS) { finish(); return } raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
  }
}

/** Yozuv tugadi: o'lchagich to'xtaydi, mikrofon oqimi esa keyingi yozuv uchun saqlanadi (mic.ts). */
function stopStream() {
  cancelAnimationFrame(raf)
  stream = null
  audioCtx?.close().catch(() => {})
  audioCtx = null
}

function reset() {
  state.value = 'idle'
  dx.value = 0
  dy.value = 0
  level.value = 0
  pointerId = null
}

function finish() {
  if (!isRec.value) return
  discard = false
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  else stopStream()
  reset()
}

function cancel(silent = false) {
  if (!isRec.value) return
  discard = true
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  stopStream()
  if (!silent) {
    cancelling.value = true
    haptic('error')
    setTimeout(() => { cancelling.value = false }, 520)
  }
  reset()
}

function finished() {
  const type = (recorder?.mimeType || chunks[0]?.type || 'audio/webm').split(';')[0]
  const blob = new Blob(chunks, { type })
  const duration = performance.now() - startedAt
  recorder = null
  stopStream()
  if (discard || duration < 700 || blob.size < 1200) return
  emit('voice', { blob, type, ms: duration, wave: compress(wave) })
  haptic('light')
}

/** To'lqinni 32 ustunga keltiradi (ovozli xabar pufagidagi chiziqlar). */
function compress(w: number[]): number[] {
  const n = 32
  if (!w.length) return Array(n).fill(0.1)
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * w.length) / n)
    const b = Math.max(a + 1, Math.floor(((i + 1) * w.length) / n))
    const slice = w.slice(a, b)
    return Math.max(0.08, Math.min(1, Math.max(...slice) * 1.4))
  })
}

// ---- Barmoq: bosib turish / chapga — bekor / yuqoriga — qulf ---------------------------------

function onDown(e: PointerEvent) {
  if (hasText.value || props.disabled || state.value !== 'idle') return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  pointerId = e.pointerId
  startX = e.clientX
  startY = e.clientY
  downAt = performance.now()
  ms.value = 0
  state.value = 'recording'
  haptic('light')
  void begin().then((ok) => { if (!ok) reset() })
}
function onMove(e: PointerEvent) {
  if (state.value !== 'recording' || e.pointerId !== pointerId) return
  dx.value = Math.min(0, e.clientX - startX)
  dy.value = Math.min(0, e.clientY - startY)
  if (dx.value < CANCEL_X) cancel()
  else if (dy.value < LOCK_Y) {
    state.value = 'locked'
    dx.value = 0
    dy.value = 0
    haptic('select')
  }
}
function onUp(e: PointerEvent) {
  if (e.pointerId !== pointerId) return
  pointerId = null
  if (state.value !== 'recording') return
  // Qisqa bosish — Telegram kabi maslahat: "ushlab turing".
  if (performance.now() - downAt < 350) {
    cancel(true)
    if (readyHint.value) return
    hint.value = true
    clearTimeout(hintTimer)
    hintTimer = window.setTimeout(() => { hint.value = false }, 1800)
    return
  }
  finish()
}
function onAction() {
  if (hasText.value) sendText()
}

onBeforeUnmount(() => { cancel(true); clearTimeout(hintTimer); releaseMicSoon() })

const timeText = computed(() => {
  const s = Math.floor(ms.value / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')},${Math.floor((ms.value % 1000) / 100)}`
})
const slideOpacity = computed(() => Math.max(0, 1 + dx.value / 140))
</script>

<template>
  <div class="tc" :class="{ rec: isRec, locked: state === 'locked', cancelling }">
    <Transition name="tc-hint">
      <div v-if="hint || readyHint" class="tc-hint">{{ readyHint ? t('cloud.ai.micReady') : t('cloud.ai.holdToRecord') }}</div>
    </Transition>

    <div class="tc-bar">
      <!-- Oddiy holat: matn maydoni -->
      <div v-show="!isRec" class="tc-field" :class="{ gone: cancelling }">
        <textarea ref="field" v-model="text" rows="1" :placeholder="t('cloud.ai.message')" enterkeyhint="send" :disabled="disabled"
          @input="autosize" @keydown.enter.exact.prevent="sendText" />
      </div>
      <!-- Yozish holati: qizil nuqta + taymer + "chapga suring" / "Bekor qilish" -->
      <div v-show="isRec" class="tc-rec">
        <span class="tc-dot" />
        <span class="tc-time">{{ timeText }}</span>
        <span v-if="state === 'recording'" class="tc-slide" :style="{ transform: `translateX(${dx * 0.6}px)`, opacity: slideOpacity }">
          <ChevronLeft class="h-4 w-4" /> {{ t('cloud.ai.slideToCancel') }}
        </span>
        <button v-else type="button" class="tc-cancel" @click="cancel()">{{ t('cloud.ai.cancel') }}</button>
      </div>
      <div v-if="cancelling" class="tc-trash"><Trash2 class="h-5 w-5" /></div>

      <!-- Mikrofon ↔ yuborish (matn bo'lsa) -->
      <button type="button" class="tc-action" :class="{ send: hasText }" :disabled="disabled" :aria-label="hasText ? t('cloud.ai.send') : t('cloud.ai.record')"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @click="onAction" @contextmenu.prevent>
        <span class="tc-ico tc-mic" :class="{ show: !hasText }"><Mic class="h-6 w-6" /></span>
        <span class="tc-ico tc-send" :class="{ show: hasText }"><ArrowUp class="h-5 w-5" /></span>
      </button>
    </div>

    <!-- Katta doira (barmoq ostida) + qulf -->
    <Transition name="tc-big">
      <div v-if="isRec" class="tc-big" :style="{ transform: `translate(${dx}px, ${dy}px)` }">
        <span class="tc-blob" :style="{ transform: `scale(${1 + level * 0.9})` }" />
        <span class="tc-blob b2" :style="{ transform: `scale(${1 + level * 0.55})` }" />
        <button v-if="state === 'locked'" type="button" class="tc-big-btn" :aria-label="t('cloud.ai.send')" @click="finish"><ArrowUp class="h-7 w-7" /></button>
        <span v-else class="tc-big-btn"><Mic class="h-7 w-7" /></span>
      </div>
    </Transition>
    <Transition name="tc-lock">
      <div v-if="state === 'recording'" class="tc-lock" :style="{ transform: `translateY(${Math.max(dy, LOCK_Y) * 0.5}px)` }">
        <Lock class="h-4 w-4" :class="{ closing: dy < LOCK_Y * 0.6 }" />
        <ChevronUp class="h-4 w-4 opacity-60" />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.tc {
  position: relative;
  padding: 0.5rem 0 calc(env(safe-area-inset-bottom) * 0 + 0.25rem);
  user-select: none;
  -webkit-user-select: none;
}
.tc-bar {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  min-height: 3rem;
}
.tc-field {
  flex: 1;
  min-width: 0;
  padding: 0.3rem 0.5rem 0.3rem 1rem;
  border-radius: 1.5rem;
  background: var(--card);
  box-shadow: inset 0 1px 0 var(--glass-edge, transparent), inset 0 0 0 0.5px var(--glass-rim, var(--border)), 0 1px 2px rgb(0 0 0 / 0.06);
  transition: opacity 0.2s, transform 0.2s;
}
.tc-field.gone {
  opacity: 0;
  transform: translateX(-12px);
}
.tc-field textarea {
  display: block;
  width: 100%;
  min-height: 2.4rem;
  max-height: 8.25rem;
  padding: 0.55rem 0;
  border: 0;
  outline: none;
  background: transparent;
  font-size: 16px;
  line-height: 1.3;
  resize: none;
  user-select: text;
  -webkit-user-select: text;
}

/* Mikrofon ↔ yuborish: ikkala ikonka ustma-ust, biri kichrayib aylanadi, ikkinchisi kattalashadi. */
.tc-action {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: 3rem;
  height: 3rem;
  border-radius: 9999px;
  color: var(--muted-foreground);
  touch-action: none;
  transition: background-color 0.2s, color 0.2s, transform 0.12s;
}
/* Telegram: mikrofon ham, yuborish ham — tugma rangidagi doira, oq ikonka. */
.tc-action {
  background-color: var(--primary);
  color: var(--on-tint, #fff);
  box-shadow: 0 2px 6px -2px rgb(0 0 0 / 0.35);
}
.tc-action.send {
  background-color: var(--glass-tint, var(--primary));
  background-image: linear-gradient(180deg, rgb(255 255 255 / 0.22), transparent 55%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.3), 0 6px 16px -8px rgb(0 0 0 / 0.5);
  color: var(--on-tint, #fff);
}
.tc-ico {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 0;
  transform: scale(0.3) rotate(-45deg);
  transition: transform 0.24s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.18s;
}
.tc-ico.show {
  opacity: 1;
  transform: none;
}
.rec .tc-action {
  opacity: 0;
}

/* Yozish qatori */
.tc-rec {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 0.6rem;
  min-height: 3rem;
  padding: 0 0.75rem 0 1rem;
  border-radius: 1.5rem;
  background: var(--card);
  box-shadow: inset 0 1px 0 var(--glass-edge, transparent), inset 0 0 0 0.5px var(--glass-rim, var(--border));
  overflow: hidden;
  animation: tc-rec-in 0.18s ease both;
}
@keyframes tc-rec-in {
  from {
    opacity: 0;
    transform: translateX(14px);
  }
}
.tc-dot {
  position: relative;
  z-index: 2;
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 9999px;
  background: #ff3b30;
  animation: tc-blink 1s ease-in-out infinite;
}
@keyframes tc-blink {
  50% {
    opacity: 0.15;
  }
}
.tc-time {
  position: relative;
  z-index: 2;
  flex: none;
  min-width: 3.4rem;
  padding-right: 0.5rem;
  background: var(--card);
  box-shadow: 10px 0 10px var(--card);
  font-size: 0.95rem;
  font-variant-numeric: tabular-nums;
}
.tc-slide {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 2px;
  margin-right: 3.5rem;
  color: var(--muted-foreground);
  font-size: 0.875rem;
  white-space: nowrap;
  /* Telegram'dagi kabi yaltiroq "suring" yozuvi. */
  background: linear-gradient(90deg, var(--muted-foreground) 30%, var(--foreground) 50%, var(--muted-foreground) 70%) 0 0 / 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: tc-shine 2.2s linear infinite;
}
.tc-slide :deep(svg) {
  color: var(--muted-foreground);
}
@keyframes tc-shine {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -50% 0;
  }
}
.tc-cancel {
  flex: 1;
  margin-right: 3.5rem;
  color: #ff3b30;
  font-size: 0.95rem;
  font-weight: 600;
}

/* Bekor qilinganda — savatcha "yutadi". */
.tc-trash {
  position: absolute;
  left: 0.9rem;
  top: 50%;
  color: #ff3b30;
  animation: tc-trash 0.5s ease both;
}
@keyframes tc-trash {
  0% {
    opacity: 0;
    transform: translateY(-50%) scale(0.4);
  }
  35% {
    opacity: 1;
    transform: translateY(-50%) scale(1.15) rotate(-12deg);
  }
  100% {
    opacity: 0;
    transform: translateY(-20%) scale(0.6);
  }
}

/* Katta doira: mikrofon tugmasi o'rnida, barmoq bilan siljiydi, ovozga qarab "nafas oladi". */
.tc-big {
  position: absolute;
  right: -1.25rem;
  bottom: -1.25rem;
  display: grid;
  place-items: center;
  width: 6.5rem;
  height: 6.5rem;
  pointer-events: none;
  transition: transform 0.06s linear;
}
.locked .tc-big {
  pointer-events: auto;
  transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.tc-blob {
  position: absolute;
  width: 5.25rem;
  height: 5.25rem;
  border-radius: 9999px;
  background: color-mix(in oklab, var(--glass-tint, var(--primary)) 18%, transparent);
  transition: transform 0.09s linear;
}
.tc-blob.b2 {
  background: color-mix(in oklab, var(--glass-tint, var(--primary)) 26%, transparent);
}
.tc-big-btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 5.25rem;
  height: 5.25rem;
  border-radius: 9999px;
  background-color: var(--glass-tint, var(--primary));
  background-image: linear-gradient(180deg, rgb(255 255 255 / 0.24), transparent 55%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.3), 0 12px 28px -10px rgb(0 0 0 / 0.55);
  color: var(--on-tint, #fff);
}
.tc-big-enter-active {
  transition: opacity 0.18s, transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.tc-big-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.tc-big-enter-from,
.tc-big-leave-to {
  opacity: 0;
  transform: scale(0.4) !important;
}

/* Qulf: katta doira ustida, barmoq yuqoriga borsa ko'tariladi. */
.tc-lock {
  position: absolute;
  right: 0.25rem;
  bottom: 6.25rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 2.5rem;
  padding: 0.6rem 0 0.45rem;
  border-radius: 9999px;
  background: var(--glass-strong, var(--card));
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  box-shadow: inset 0 1px 0 var(--glass-edge, transparent), inset 0 0 0 0.5px var(--glass-rim, var(--border)), 0 8px 20px -10px rgb(0 0 0 / 0.4);
  pointer-events: none;
  transition: transform 0.06s linear;
}
.tc-lock .closing {
  transform: translateY(2px);
}
.tc-lock :deep(svg:last-child) {
  animation: tc-up 1.2s ease-in-out infinite;
}
@keyframes tc-up {
  50% {
    transform: translateY(-3px);
  }
}
.tc-lock-enter-active,
.tc-lock-leave-active {
  transition: opacity 0.2s, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.tc-lock-enter-from,
.tc-lock-leave-to {
  opacity: 0;
  transform: translateY(16px) !important;
}

.tc-hint {
  position: absolute;
  right: 0;
  bottom: 3.75rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.75rem;
  background: rgb(20 20 22 / 0.86);
  color: #fff;
  font-size: 0.8125rem;
  white-space: nowrap;
}
.tc-hint::after {
  content: '';
  position: absolute;
  right: 1.1rem;
  bottom: -5px;
  width: 10px;
  height: 10px;
  background: inherit;
  transform: rotate(45deg);
}
.tc-hint-enter-active,
.tc-hint-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.tc-hint-enter-from,
.tc-hint-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
