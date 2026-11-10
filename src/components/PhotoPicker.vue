<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue'
import { Camera, ImagePlus, X } from 'lucide-vue-next'

// Telefon uchun rasm qo'shish (hostel mini app'idagi kabi): tanlangan rasm plitkasi (✕ bilan)
// + "Kamera" va "Galereya" plitkalari. Kamera: iPhone/iPad'da tizim kamerasi (`<input capture>`,
// to'liq sifat); boshqa joyda — ilova ichidagi jonli kamera (PhotoCamera), ochilmasa — fayl.
const PhotoCamera = defineAsyncComponent(() => import('./PhotoCamera.vue'))

defineProps<{ image: string | null | undefined }>()
const emit = defineEmits<{ file: [file: File]; clear: [] }>()

const gallery = ref<HTMLInputElement | null>(null)
const capture = ref<HTMLInputElement | null>(null)
const live = ref(false)

const tgPlatform = (window as unknown as { Telegram?: { WebApp?: { platform?: string } } }).Telegram?.WebApp?.platform
const ios = tgPlatform === 'ios' || /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
const liveCamera = () => !ios && typeof navigator.mediaDevices?.getUserMedia === 'function'

function take(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (f) emit('file', f)
}
function openCamera() { if (liveCamera()) live.value = true; else capture.value?.click() }
function onShot(f: File) { live.value = false; emit('file', f) }
function onFallback() { live.value = false; gallery.value?.click() }
</script>

<template>
  <div class="pp">
    <div v-if="image" class="pp-tile">
      <img :src="image" alt="" />
      <button type="button" class="pp-del" :aria-label="$t('photo.remove')" @click="emit('clear')"><X class="h-4 w-4" /></button>
    </div>
    <button type="button" class="pp-tile pp-add" @click="openCamera"><Camera class="h-[22px] w-[22px]" />{{ $t('photo.camera') }}</button>
    <button type="button" class="pp-tile pp-add" @click="gallery?.click()"><ImagePlus class="h-[22px] w-[22px]" />{{ $t('photo.gallery') }}</button>
    <input ref="gallery" type="file" accept="image/*" hidden @change="take" />
    <input ref="capture" type="file" accept="image/*" capture="environment" hidden @change="take" />
    <PhotoCamera v-if="live" @shot="onShot" @close="live = false" @fallback="onFallback" />
  </div>
</template>

<style scoped>
.pp {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.pp-tile {
  position: relative;
  overflow: hidden;
  aspect-ratio: 1;
  border-radius: 16px;
  background: var(--muted);
}
.pp-tile img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  animation: pp-in 0.24s ease both;
}
@keyframes pp-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
}
.pp-add {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1.5px dashed color-mix(in srgb, var(--foreground) 28%, transparent);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 600;
}
.pp-add:active {
  background: var(--accent);
}
.pp-del {
  position: absolute;
  top: 6px;
  right: 6px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 9999px;
  background: rgb(0 0 0 / 0.5);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: #fff;
}
</style>
