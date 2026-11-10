<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, ImagePlus, RotateCcw, SwitchCamera, X } from 'lucide-vue-next'

// Ilova ichidagi kamera (hostel mini app'idagi PhotoAdd → CameraView kabi): jonli tasvir,
// tugma bilan surat, keyin "Qayta olish" yoki "Ishlatish". Android Telegram `<input capture>` ni
// fayl tanlagichga beradi — shuning uchun kamerani o'zimiz ochamiz. Ruxsat yo'q/kamera yo'q →
// "Rasm tanlash" (fallback) taklif qilinadi.
const emit = defineEmits<{ shot: [file: File]; close: []; fallback: [] }>()

const video = ref<HTMLVideoElement | null>(null)
const state = ref<'starting' | 'live' | 'error'>('starting')
const facing = ref<'environment' | 'user'>('environment')
const cameras = ref(0)
const shot = ref<{ file: File; url: string } | null>(null)
let stream: MediaStream | null = null
let alive = true

function stop() { stream?.getTracks().forEach((t) => t.stop()); stream = null }
async function start() {
  stop()
  state.value = 'starting'
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing.value }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
    if (!alive) { s.getTracks().forEach((t) => t.stop()); return }
    stream = s
    const v = video.value!
    v.srcObject = s
    await v.play().catch(() => {})
    state.value = 'live'
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
    cameras.value = devices.filter((d) => d.kind === 'videoinput').length
  } catch {
    if (alive) state.value = 'error'
  }
}
watch(facing, start)

let prevOverflow = ''
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.stopPropagation(); emit('close') } }
onMounted(() => {
  prevOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  window.addEventListener('keydown', onKey, true)
  void start()
})
onBeforeUnmount(() => {
  alive = false
  stop()
  if (shot.value) URL.revokeObjectURL(shot.value.url)
  document.body.style.overflow = prevOverflow
  window.removeEventListener('keydown', onKey, true)
})

function capture() {
  const v = video.value
  if (!v || !v.videoWidth) return
  const c = document.createElement('canvas')
  c.width = v.videoWidth
  c.height = v.videoHeight
  c.getContext('2d')!.drawImage(v, 0, 0)
  c.toBlob((b) => {
    if (!b) return
    shot.value = { file: new File([b], `kamera-${Date.now()}.jpg`, { type: 'image/jpeg' }), url: URL.createObjectURL(b) }
  }, 'image/jpeg', 0.92)
}
function retake() { if (shot.value) URL.revokeObjectURL(shot.value.url); shot.value = null }
</script>

<template>
  <Teleport to="body">
    <div class="pc" role="dialog" :aria-label="$t('photo.camera')">
      <div class="pc-top">
        <button type="button" class="pc-round" :aria-label="$t('common.close')" @click="emit('close')"><X class="h-[22px] w-[22px]" /></button>
        <span>{{ shot ? $t('photo.isClear') : $t('photo.take') }}</span>
        <button v-if="cameras > 1 && !shot" type="button" class="pc-round" :aria-label="$t('photo.switch')" @click="facing = facing === 'environment' ? 'user' : 'environment'"><SwitchCamera class="h-[21px] w-[21px]" /></button>
        <span v-else class="w-11" />
      </div>
      <div class="pc-view">
        <video ref="video" playsinline muted :hidden="!!shot" />
        <img v-if="shot" :src="shot.url" alt="" />
        <div v-if="state === 'starting'" class="pc-msg">{{ $t('photo.opening') }}</div>
        <div v-if="state === 'error'" class="pc-msg">
          <div>
            <b>{{ $t('photo.failed') }}</b>
            <p>{{ $t('photo.failedHint') }}</p>
            <button type="button" class="pc-btn primary" @click="emit('fallback')"><ImagePlus class="h-[18px] w-[18px]" /> {{ $t('photo.pickFile') }}</button>
          </div>
        </div>
      </div>
      <div class="pc-bar">
        <template v-if="shot">
          <button type="button" class="pc-btn" @click="retake"><RotateCcw class="h-[18px] w-[18px]" /> {{ $t('photo.retake') }}</button>
          <button type="button" class="pc-btn primary" @click="emit('shot', shot.file)"><Check class="h-[18px] w-[18px]" /> {{ $t('photo.use') }}</button>
        </template>
        <button v-else-if="state !== 'error'" type="button" class="pc-shutter" :aria-label="$t('photo.take')" :disabled="state !== 'live'" @click="capture" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pc {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  flex-direction: column;
  background: #000;
  color: #fff;
  animation: pc-in 0.24s ease both;
}
@keyframes pc-in {
  from {
    opacity: 0;
  }
}
.pc-top {
  position: absolute;
  inset: 0 0 auto;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: calc(12px + env(safe-area-inset-top)) 16px 12px;
  background: linear-gradient(rgb(0 0 0 / 0.6), transparent);
  font-size: 15px;
  font-weight: 600;
  text-align: center;
}
.pc-round {
  display: grid;
  flex: none;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 9999px;
  background: rgb(255 255 255 / 0.16);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.25);
  color: #fff;
}
.pc-view {
  position: relative;
  flex: 1;
  min-height: 0;
}
.pc-view video,
.pc-view img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.pc-view video[hidden] {
  display: none;
}
.pc-msg {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  color: rgb(255 255 255 / 0.85);
  text-align: center;
}
.pc-msg p {
  max-width: 300px;
  margin: 8px auto 18px;
  color: rgb(255 255 255 / 0.7);
  font-size: 14px;
  line-height: 1.45;
}
.pc-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 112px;
  padding: 16px 20px calc(16px + env(safe-area-inset-bottom));
}
.pc-shutter {
  display: grid;
  place-items: center;
  width: 74px;
  height: 74px;
  border: 4px solid #fff;
  border-radius: 9999px;
}
.pc-shutter::after {
  content: '';
  width: 58px;
  height: 58px;
  border-radius: 9999px;
  background: #fff;
  transition: transform 0.1s;
}
.pc-shutter:active::after {
  transform: scale(0.88);
}
.pc-shutter:disabled {
  opacity: 0.4;
}
.pc-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 20px;
  border-radius: 9999px;
  background: rgb(255 255 255 / 0.16);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.25);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
}
.pc-btn.primary {
  background: #fff;
  color: #000;
}
</style>
