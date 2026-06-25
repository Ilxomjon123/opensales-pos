<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import jsQR from 'jsqr'
import { X, Camera } from 'lucide-vue-next'

const emit = defineEmits<{ decoded: [text: string]; close: [] }>()

const video = ref<HTMLVideoElement | null>(null)
const error = ref('')
let stream: MediaStream | null = null
let raf = 0
const canvas = document.createElement('canvas')

onMounted(async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    if (video.value) {
      video.value.srcObject = stream
      await video.value.play()
      scan()
    }
  } catch (e: any) {
    error.value = 'Kameraga ruxsat yo\'q yoki kamera topilmadi'
  }
})

function scan() {
  const v = video.value
  if (!v || v.readyState !== v.HAVE_ENOUGH_DATA) { raf = requestAnimationFrame(scan); return }
  canvas.width = v.videoWidth
  canvas.height = v.videoHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const code = jsQR(img.data, img.width, img.height)
  if (code?.data) { emit('decoded', code.data); return }
  raf = requestAnimationFrame(scan)
}

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  stream?.getTracks().forEach((t) => t.stop())
})
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <div class="w-full max-w-sm overflow-hidden rounded-2xl border bg-card shadow-xl">
      <div class="flex items-center justify-between border-b px-4 py-3">
        <div class="flex items-center gap-2 text-sm font-semibold"><Camera class="h-4 w-4" /> QR-kodni skanerlang</div>
        <button @click="emit('close')" class="rounded-md p-1.5 hover:bg-muted"><X class="h-4 w-4" /></button>
      </div>
      <div class="relative aspect-square bg-black">
        <video ref="video" class="h-full w-full object-cover" playsinline muted></video>
        <div v-if="!error" class="pointer-events-none absolute inset-8 rounded-xl border-2 border-white/70"></div>
        <div v-if="error" class="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white">{{ error }}</div>
      </div>
      <div class="px-4 py-3 text-center text-xs text-muted-foreground">QR-kodni ramka ichiga joylashtiring</div>
    </div>
  </div>
</template>
