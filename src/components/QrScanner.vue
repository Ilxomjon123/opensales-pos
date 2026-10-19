<script setup lang="ts">
// QR VA shtrix kod (EAN-13/8, UPC, Code128/39, ITF) o'qiydigan kamera skaneri.
// ZXing multi-format. Dekod bo'lgan matnni `decoded` orqali qaytaradi.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } from '@zxing/library'
import { X, ScanLine, Minus, ChevronUp } from 'lucide-vue-next'
import { cameraPermission, ensureCameraPermission, canOpenCameraSettings, openCameraSettings } from '../lib/camera'
import { notify } from '../lib/notify'

const { t } = useI18n()

// continuous: true bo'lsa kamera ochiq qoladi (kassa — ketma-ket savatga qo'shish).
// false (default) bo'lsa birinchi skandan keyin to'xtaydi (litsenziya QR va h.k.).
// dock: true bo'lsa to'liq ekran modal emas, burchakда kichik ko'chiriladigan panel —
//   ishni to'smaydi, kassir grid'dan qo'lда ham tovar qo'shaveradi.
const props = withDefaults(defineProps<{ continuous?: boolean; dock?: boolean }>(), { continuous: false, dock: false })
// decoded: dekod matni + simbologiya nomi (QR_CODE, DATA_MATRIX, EAN_13, ...).
const emit = defineEmits<{ decoded: [text: string, format: string]; close: [] }>()
const fmtName = (f: BarcodeFormat) => BarcodeFormat[f] ?? 'AUTO'

const video = ref<HTMLVideoElement | null>(null)
// Xato turi — har biri boshqa yechim talab qiladi (ruxsat / kamera ulash / boshqa dasturni yopish).
type CamError = 'denied' | 'notFound' | 'busy' | 'error'
const camError = ref<CamError | null>(null)
const errorKeys: Record<CamError, string> = {
  denied: 'qrScanner.cameraDenied', notFound: 'qrScanner.cameraNotFound', busy: 'qrScanner.cameraBusy', error: 'qrScanner.cameraError',
}
const error = computed(() => (camError.value ? t(errorKeys[camError.value]) : ''))
const requesting = ref(false) // tizim ruxsat oynasi ochiq — javob kutilmoqda
let disposed = false
const hit = ref(false) // har muvaffaqiyatli skanда yashil chaqnash
const collapsed = ref(false) // dock: kamera ko'rinishini yashirib faqat sarlavha qoldirish

// Dock panel joylashuvi (ko'chirilsa). null = standart burchak.
const dockPos = ref<{ left: number; top: number } | null>(null)
function startDrag(e: PointerEvent) {
  if (!props.dock) return
  const card = (e.currentTarget as HTMLElement).closest('[data-dock]') as HTMLElement
  if (!card) return
  const r = card.getBoundingClientRect()
  const offX = e.clientX - r.left
  const offY = e.clientY - r.top
  const move = (ev: PointerEvent) => {
    const left = Math.min(window.innerWidth - r.width - 4, Math.max(4, ev.clientX - offX))
    const top = Math.min(window.innerHeight - 44, Math.max(4, ev.clientY - offY))
    dockPos.value = { left, top }
  }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
let reader: BrowserMultiFormatReader | null = null
// Dublikat to'sig'i: bir xil kod 1.2s ichida qayta yuborilmaydi (kamera har kadrни o'qiydi).
let lastCode = ''
let lastTime = 0
// Noto'g'ri o'qishга qarshi: kod ketma-ket shuncha marta AYNAN bir xil chiqsagina qabul.
// MacBook/webcam autofokussiz — bitta kadr xato bo'lishi mumkin, tasdiq buni filtrlaydi.
const CONFIRM = 3
let pendCode = ''
let pendCount = 0

// Faqat checksumли (o'zini-tekshiradigan) formatlar — noto'g'ri o'qish keskin kamayadi.
// CODE_39 va ITF olib tashlandi: ularда checksum yo'q → yarim o'qiса ham "to'g'ri" deb beradi.
const hints = new Map()
hints.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX, // 2D matritsa (kichik tovar, lazer-grav) — Reed-Solomon EC, xato kam
  BarcodeFormat.AZTEC,
  BarcodeFormat.PDF_417,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
])
// TRY_HARDER o'chirilgan: u agressiv → past sifatли kadrда xato o'qishni oshiradi.
// Tasdiq (CONFIRM) ishonchlilikni ta'minlaydi.

function classify(e: unknown): CamError {
  const name = (e as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'notFound'
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'busy'
  return 'error'
}

async function start() {
  camError.value = null
  stop()
  // Avval OS ruxsati: hali so'ralmagan bo'lsa tizim oynasi shu yerda ochiladi. Rad etilgan
  // bo'lsa getUserMedia'ni chaqirib o'tirmaymiz — macOS baribir qayta so'ramaydi.
  requesting.value = true
  const perm = await ensureCameraPermission()
  requesting.value = false
  if (disposed) return
  if (perm === 'denied' || perm === 'restricted') { camError.value = 'denied'; return }
  try {
    // Yuqori rezolyutsiya — kichik shtrix chiziqlar ajralishi uchun. Orqa kamera + uzluksiz fokus.
    reader = new BrowserMultiFormatReader(hints, 150)
    await reader.decodeFromConstraints(
      {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          // @ts-ignore — barcha brauzerда yo'q, qo'llab-quvvatlasa fokusни yaxshilaydi
          advanced: [{ focusMode: 'continuous' }],
        },
      },
      video.value!,
      (result) => {
        if (!result) return
        const code = result.getText()
        const fmt = fmtName(result.getBarcodeFormat())
        // Tasdiq: ketma-ket bir xil bo'lsa hisoblaymiz, farq qilsa nolдан.
        if (code === pendCode) pendCount++
        else { pendCode = code; pendCount = 1 }
        if (pendCount < CONFIRM) return // hali tasdiqlanmagan — kutamiz
        pendCount = 0

        if (!props.continuous) { stop(); emit('decoded', code, fmt); return } // bitta skan
        const now = Date.now()
        if (code === lastCode && now - lastTime < 1200) return // dublikat — o'tkazib yubor
        lastCode = code
        lastTime = now
        hit.value = true
        setTimeout(() => (hit.value = false), 300)
        emit('decoded', code, fmt) // kamera ochiq qoladi — ketma-ket skan
      },
    )
  } catch (e: unknown) {
    console.error('camera:', e)
    if (!disposed) camError.value = classify(e)
  }
}

// "Ruxsat berish": hali so'ralmagan bo'lsa tizim oynasi, rad etilgan bo'lsa Tizim
// sozlamalarining Kamera bo'limi (dastur rad etilgan ruxsatni qayta so'ray olmaydi).
async function grant() {
  if ((await cameraPermission()) === 'prompt' || !canOpenCameraSettings) return start()
  try { await openCameraSettings() } catch (e) { notify(String(e), 'error') }
}

// Sozlamalarda ruxsat berib qaytganda (oyna fokus oladi) o'zimiz qayta urinamiz.
function onFocus() { if (camError.value === 'denied' && !requesting.value) void start() }

function stop() {
  try { reader?.reset() } catch { /* ignore */ }
  reader = null
}
onMounted(() => { window.addEventListener('focus', onFocus); void start() })
onBeforeUnmount(() => { disposed = true; window.removeEventListener('focus', onFocus); stop() })
</script>

<template>
  <!-- Dock: backdrop yo'q (ishni to'smaydi). Modal: to'liq ekran qora fon. -->
  <div :class="dock ? '' : 'fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4'">
    <div
      v-if="dock" data-dock
      :style="dockPos ? { left: dockPos.left + 'px', top: dockPos.top + 'px', right: 'auto', bottom: 'auto' } : {}"
      class="fixed bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] left-3 z-40 w-48 overflow-hidden rounded-xl border bg-card shadow-2xl lg:bottom-4 lg:left-4 lg:w-56"
    >
      <div @pointerdown="startDrag" class="flex cursor-move touch-none items-center justify-between border-b px-2.5 py-1.5">
        <div class="flex items-center gap-1.5 text-xs font-semibold"><ScanLine class="h-3.5 w-3.5" /> {{ $t('qrScanner.scanner') }}</div>
        <div class="flex items-center gap-0.5">
          <button @click="collapsed = !collapsed" class="rounded p-1 text-muted-foreground hover:bg-muted" :title="collapsed ? $t('qrScanner.expand') : $t('qrScanner.collapse')"><component :is="collapsed ? ChevronUp : Minus" class="h-3.5 w-3.5" /></button>
          <button @click="emit('close')" class="rounded p-1 text-muted-foreground hover:bg-muted" :title="$t('common.close')"><X class="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <div v-show="!collapsed" class="relative aspect-square bg-black">
        <video ref="video" class="h-full w-full object-cover" playsinline muted></video>
        <div v-if="requesting" class="absolute inset-0 flex items-center justify-center p-3 text-center text-xs text-white/80">{{ $t('qrScanner.requestingPermission') }}</div>
        <template v-else-if="!error">
          <div class="pointer-events-none absolute inset-x-4 inset-y-8 rounded-lg border-2 border-white/70">
            <div class="scan-line absolute inset-x-0 h-0.5 bg-primary shadow-[0_0_8px_2px] shadow-primary/60"></div>
          </div>
        </template>
        <div v-if="error" class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center text-xs text-white">
          <span>{{ error }}</span>
          <div class="flex flex-wrap justify-center gap-1.5">
            <button v-if="camError === 'denied'" @click="grant" class="rounded-md bg-white px-2.5 py-1 font-semibold text-black hover:bg-white/90">{{ $t('qrScanner.grantAccess') }}</button>
            <button @click="start" class="rounded-md bg-white/15 px-2.5 py-1 font-medium hover:bg-white/25">{{ $t('qrScanner.retry') }}</button>
          </div>
        </div>
        <div v-if="hit" class="pointer-events-none absolute inset-0 bg-emerald-400/40"></div>
      </div>
    </div>

    <div v-else class="w-full max-w-sm overflow-hidden rounded-2xl border bg-card shadow-xl">
      <div class="flex items-center justify-between border-b px-4 py-3">
        <div class="flex items-center gap-2 text-sm font-semibold"><ScanLine class="h-4 w-4" /> {{ $t('qrScanner.scanCode') }}</div>
        <button @click="emit('close')" class="rounded-md p-1.5 hover:bg-muted"><X class="h-4 w-4" /></button>
      </div>
      <div class="relative aspect-square bg-black">
        <video ref="video" class="h-full w-full object-cover" playsinline muted></video>
        <div v-if="requesting" class="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white/80">{{ $t('qrScanner.requestingPermission') }}</div>
        <!-- Skanerlash ramkasi + harakatlanuvchi chiziq -->
        <template v-else-if="!error">
          <div class="pointer-events-none absolute inset-x-6 inset-y-12 rounded-xl border-2 border-white/70">
            <span class="absolute -left-0.5 -top-0.5 h-6 w-6 rounded-tl-xl border-l-4 border-t-4 border-primary"></span>
            <span class="absolute -right-0.5 -top-0.5 h-6 w-6 rounded-tr-xl border-r-4 border-t-4 border-primary"></span>
            <span class="absolute -bottom-0.5 -left-0.5 h-6 w-6 rounded-bl-xl border-b-4 border-l-4 border-primary"></span>
            <span class="absolute -bottom-0.5 -right-0.5 h-6 w-6 rounded-br-xl border-b-4 border-r-4 border-primary"></span>
            <div class="scan-line absolute inset-x-0 h-0.5 bg-primary shadow-[0_0_8px_2px] shadow-primary/60"></div>
          </div>
        </template>
        <div v-if="error" class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-white">
          <span>{{ error }}</span>
          <div class="flex flex-wrap justify-center gap-2">
            <button v-if="camError === 'denied'" @click="grant" class="rounded-md bg-white px-3 py-1.5 font-semibold text-black hover:bg-white/90">{{ $t('qrScanner.grantAccess') }}</button>
            <button @click="start" class="rounded-md bg-white/15 px-3 py-1.5 font-medium hover:bg-white/25">{{ $t('qrScanner.retry') }}</button>
          </div>
        </div>
        <!-- Skan qabul qilindi — yashil chaqnash -->
        <div v-if="hit" class="pointer-events-none absolute inset-0 bg-emerald-400/30"></div>
      </div>
      <div class="px-4 py-3 text-center text-xs text-muted-foreground">{{ $t('qrScanner.placeInFrame') }}<template v-if="continuous"> · {{ $t('qrScanner.continuousHint') }}</template></div>
    </div>
  </div>
</template>

<style scoped>
.scan-line { animation: scan 2s ease-in-out infinite; }
@keyframes scan {
  0% { top: 4%; }
  50% { top: 96%; }
  100% { top: 4%; }
}
</style>
