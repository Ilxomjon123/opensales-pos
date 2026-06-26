<script setup lang="ts">
import { ref, nextTick } from 'vue'
import QRCode from 'qrcode'
import { X, KeyRound, Copy, Check, Eye, EyeOff, QrCode as QrCodeIcon } from 'lucide-vue-next'
import { isOwnerMaster, generateKey, deactivate } from '../lib/license'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'
import QrScanButton from './QrScanButton.vue'

const props = defineProps<{ deviceId: string }>()
const emit = defineEmits<{ close: [] }>()

const unlocked = ref(false)
const master = ref('')
const masterErr = ref('')

const targetDevice = ref(props.deviceId)
const duration = ref<'15' | '30' | '90' | '180' | '365' | 'custom' | 'forever'>('30')
const customDate = ref('')
const seed = ref(localStorage.getItem('owner_seed') ?? '')
const rememberSeed = ref(!!localStorage.getItem('owner_seed'))
const result = ref('')
const copied = ref(false)
const showSeed = ref(false)
const showQr = ref(false)
const qrCanvas = ref<HTMLCanvasElement | null>(null)

async function toggleQr() {
  showQr.value = !showQr.value
  if (showQr.value) {
    await nextTick()
    if (qrCanvas.value) {
      try { await QRCode.toCanvas(qrCanvas.value, result.value, { width: 256, margin: 1, errorCorrectionLevel: 'L' }) }
      catch (e: any) { notify(e?.message ?? 'QR yaratib bo\'lmadi', 'error'); showQr.value = false }
    }
  }
}

function unlock() {
  if (isOwnerMaster(master.value)) { unlocked.value = true; masterErr.value = '' }
  else masterErr.value = 'Master kalit noto\'g\'ri'
}

function expFromDuration(): string | null {
  if (duration.value === 'forever') return null
  if (duration.value === 'custom') return customDate.value
  const d = new Date()
  d.setDate(d.getDate() + Number(duration.value))
  return d.toISOString().slice(0, 10)
}

function generate() {
  result.value = ''
  showQr.value = false
  if (!targetDevice.value.trim()) { notify('Qurilma ID kiriting', 'error'); return }
  if (duration.value === 'custom' && !customDate.value) { notify('Sanani tanlang', 'error'); return }
  if (!seed.value.trim()) { notify('Maxfiy kalit (seed) kiriting', 'error'); return }
  try {
    result.value = generateKey(targetDevice.value, expFromDuration(), seed.value)
    if (rememberSeed.value) localStorage.setItem('owner_seed', seed.value.trim())
    else localStorage.removeItem('owner_seed')
    notify('Kalit yaratildi', 'success')
  } catch (e: any) { notify(e?.message ?? 'Xato', 'error') }
}

async function copyKey() {
  try { await navigator.clipboard.writeText(result.value); copied.value = true; setTimeout(() => (copied.value = false), 1500) } catch {}
}

async function revoke() {
  if (!(await confirmDialog('Bu qurilmada litsenziya bekor qilinsinmi? Dastur aktivatsiyani kutadi va ishlamaydi.', { danger: true, title: 'Litsenziyani bekor qilish' }))) return
  await deactivate()
  notify('Litsenziya bekor qilindi', 'success')
  window.location.reload()
}
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
    <div class="w-full max-w-lg rounded-xl border bg-card p-5 shadow-xl">
      <div class="mb-4 flex items-center justify-between">
        <div class="flex items-center gap-2 text-lg font-semibold"><KeyRound class="h-5 w-5 text-primary" /> Litsenziya boshqaruvi</div>
        <button @click="emit('close')" class="rounded-lg p-1.5 hover:bg-muted"><X class="h-5 w-5" /></button>
      </div>

      <!-- Master gate -->
      <div v-if="!unlocked" class="space-y-3">
        <p class="text-sm text-muted-foreground">Bu bo'lim faqat dastur egasi uchun. Master kalitni kiriting.</p>
        <div class="flex gap-2">
          <input v-model="master" type="password" placeholder="Master kalit" autofocus
            class="h-11 w-full rounded-lg border bg-background px-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" @keyup.enter="unlock" />
          <QrScanButton @decoded="master = $event" />
        </div>
        <p v-if="masterErr" class="text-sm text-rose-500">{{ masterErr }}</p>
        <button @click="unlock" class="h-10 w-full rounded-lg bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Kirish</button>
      </div>

      <!-- Generator -->
      <div v-else class="space-y-3">
        <div>
          <label class="mb-1 block text-sm font-medium">Mijoz qurilma ID</label>
          <input v-model="targetDevice" placeholder="Masalan: A1B2C3D4E5F6G7H8" class="h-10 w-full rounded-md border bg-background px-3 text-sm tabular-nums uppercase" />
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium">Muddat</label>
          <select v-model="duration" class="h-10 w-full rounded-md border bg-background px-3 text-sm">
            <option value="15">15 kun</option>
            <option value="30">1 oy (30 kun)</option>
            <option value="90">3 oy (90 kun)</option>
            <option value="180">6 oy (180 kun)</option>
            <option value="365">1 yil (365 kun)</option>
            <option value="custom">Aniq sanagacha…</option>
            <option value="forever">Cheksiz (butunlayga)</option>
          </select>
          <input v-if="duration === 'custom'" v-model="customDate" type="date" class="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm" />
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium">Maxfiy kalit (seed) — base64 secretKey</label>
          <div class="flex gap-2">
            <div class="relative w-full">
              <input v-model="seed" :type="showSeed ? 'text' : 'password'" placeholder="Faqat sizda. Dasturga joylanmaydi."
                class="h-10 w-full rounded-md border bg-background px-3 pr-10 font-mono text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
              <button type="button" @click="showSeed = !showSeed" class="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground">
                <component :is="showSeed ? EyeOff : Eye" class="h-4 w-4" />
              </button>
            </div>
            <QrScanButton @decoded="seed = $event" />
          </div>
          <label class="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground"><input v-model="rememberSeed" type="checkbox" class="rounded" /> Shu kompyuterda eslab qol</label>
        </div>
        <button @click="generate" class="h-10 w-full rounded-lg bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Kalit yaratish</button>

        <div v-if="result" class="space-y-2 rounded-lg border bg-muted/40 p-3">
          <div class="text-xs font-medium text-muted-foreground">Aktivatsiya kaliti (mijozga yuboring):</div>
          <div class="rounded-md border bg-background p-2 font-mono text-xs break-all">{{ result }}</div>
          <div class="flex gap-2">
            <button @click="copyKey" class="flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted">
              <component :is="copied ? Check : Copy" class="h-3.5 w-3.5" /> {{ copied ? 'Nusxalandi' : 'Nusxalash' }}
            </button>
            <button @click="toggleQr" class="flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted">
              <QrCodeIcon class="h-3.5 w-3.5" /> {{ showQr ? 'QR yashirish' : 'QR ko\'rsatish' }}
            </button>
          </div>
          <div v-if="showQr" class="flex justify-center pt-1">
            <div class="rounded-lg bg-white p-3">
              <canvas ref="qrCanvas" class="block"></canvas>
            </div>
          </div>
        </div>

        <div class="mt-2 border-t pt-3">
          <button @click="revoke" class="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-rose-500/40 text-sm font-medium text-rose-600 hover:bg-rose-500/10">
            Bu qurilmada litsenziyani bekor qilish
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
