<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { KeyRound, ArrowLeft, Phone, Check, QrCode, Wifi, ShieldCheck, Printer, Globe } from 'lucide-vue-next'
import { openUrl } from '@tauri-apps/plugin-opener'
import { loginPin, verifyRecoveryKey, setPin } from '../lib/auth'
import { appVersion } from '../lib/version'
import PinPad from '../components/PinPad.vue'
import QrScanner from '../components/QrScanner.vue'
import logoDark from '../assets/logo-dark.svg'

const router = useRouter()
type Mode = 'login' | 'key' | 'newpin' | 'confirm' | 'done'
const mode = ref<Mode>('login')
const pinError = ref(false)
const loginPad = ref<InstanceType<typeof PinPad>>()
const confirmPad = ref<InstanceType<typeof PinPad>>()

const recoveryKey = ref('')
const keyError = ref('')
const firstPin = ref('')
const confirmError = ref(false)
const showScanner = ref(false)

const phone = import.meta.env.VITE_SUPPORT_PHONE ?? ''
const supportName = import.meta.env.VITE_SUPPORT_NAME ?? ''
const site = (import.meta.env.VITE_SITE_URL ?? 'https://opensales.uz') as string
const siteLabel = site.replace(/^https?:\/\//, '')
function openSite() { openUrl(site).catch(() => {}) }

async function onQrDecoded(text: string) {
  showScanner.value = false
  if (await verifyRecoveryKey(text)) { keyError.value = ''; mode.value = 'newpin' }
  else keyError.value = 'QR-kod mos kelmadi'
}
async function onLogin(p: string) {
  if (await loginPin(p)) router.push('/pos')
  else { pinError.value = true; loginPad.value?.shakeNow(); setTimeout(() => (pinError.value = false), 600) }
}
async function checkKey() {
  keyError.value = ''
  if (await verifyRecoveryKey(recoveryKey.value)) { mode.value = 'newpin' }
  else keyError.value = "Kalit so'z noto'g'ri"
}
function onNewPin(p: string) { firstPin.value = p; mode.value = 'confirm' }
async function onConfirm(p: string) {
  if (p === firstPin.value) { await setPin(p); mode.value = 'done'; setTimeout(backToLogin, 1500) }
  else { confirmError.value = true; confirmPad.value?.shakeNow(); setTimeout(() => (confirmError.value = false), 600) }
}
function backToLogin() {
  mode.value = 'login'; recoveryKey.value = ''; firstPin.value = ''; keyError.value = ''
  loginPad.value?.reset()
}
</script>

<template>
  <div class="grid h-screen bg-background text-foreground lg:grid-cols-2">
    <!-- Chap: dastur haqida (gradient) -->
    <div class="relative hidden flex-col justify-center overflow-hidden px-12 text-white lg:flex
                bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-700">
      <!-- dekorativ glow -->
      <div class="pointer-events-none absolute -top-24 -left-16 h-72 w-72 rounded-full bg-white/20 blur-3xl"></div>
      <div class="pointer-events-none absolute -bottom-24 right-0 h-80 w-80 rounded-full bg-fuchsia-300/20 blur-3xl"></div>
      <div class="pointer-events-none absolute top-1/3 left-1/2 h-64 w-64 rounded-full bg-sky-300/10 blur-3xl"></div>

      <div class="relative">
        <div class="flex items-center gap-3">
          <div class="h-14 w-14 overflow-hidden rounded-2xl bg-white/95 p-1.5 shadow-lg ring-1 ring-white/40"><img :src="logoDark" class="h-full w-full" /></div>
          <div>
            <div class="text-2xl font-bold tracking-tight">OpenSales POS</div>
            <div class="text-sm text-white/70">Offline kassa tizimi</div>
          </div>
        </div>

        <p class="mt-6 max-w-md text-sm leading-relaxed text-white/85">
          Do'kon va savdo nuqtalari uchun oddiy, tez va internetsiz ishlaydigan kassa dasturi. Sotuv, ombor, mijozlar va qarzlarni bir joyda boshqaring.
        </p>

        <div class="mt-6 max-w-md space-y-2.5">
          <div class="flex items-center gap-2.5 text-sm"><div class="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/20"><Wifi class="h-4 w-4" /></div> Internetsiz, to'liq offline ishlaydi</div>
          <div class="flex items-center gap-2.5 text-sm"><div class="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/20"><Printer class="h-4 w-4" /></div> Chek chop etish</div>
          <div class="flex items-center gap-2.5 text-sm"><div class="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/20"><ShieldCheck class="h-4 w-4" /></div> PIN-kod bilan himoya</div>
        </div>

        <button @click="openSite" class="group mt-7 flex w-full max-w-md items-center gap-3 rounded-xl border border-white/20 bg-white/10 p-3.5 text-left backdrop-blur transition hover:bg-white/15">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-violet-700"><Globe class="h-4.5 w-4.5" /></div>
          <div class="min-w-0">
            <div class="text-sm font-semibold">{{ siteLabel }}</div>
            <div class="truncate text-xs text-white/70">Batafsil ma'lumot va yangiliklar</div>
          </div>
        </button>

        <div class="mt-6 max-w-md border-t border-white/15 pt-5 text-sm">
          <div class="font-medium">{{ supportName || 'Ilxomjon Abdullayev' }}</div>
          <a v-if="phone" :href="`tel:${phone}`" class="mt-0.5 flex items-center gap-1.5 text-white/90 hover:text-white"><Phone class="h-4 w-4" /> {{ phone }}</a>
        </div>
      </div>

      <div class="absolute bottom-5 left-12 flex items-center gap-3 text-xs text-white/60">
        <span>v{{ appVersion }}</span>
        <button @click="openSite" class="flex items-center gap-1 hover:text-white"><Globe class="h-3 w-3" /> {{ siteLabel }}</button>
      </div>
    </div>

    <!-- O'ng: PIN -->
    <div class="relative flex flex-col items-center justify-center bg-gradient-to-b from-background to-muted/40 px-6">
      <div class="w-full max-w-xs">
        <!-- Kichik ekranda logo -->
        <div class="mb-8 flex flex-col items-center text-center lg:hidden">
          <div class="h-14 w-14 overflow-hidden rounded-2xl shadow-md ring-1 ring-black/10"><img :src="logoDark" class="h-full w-full" /></div>
          <div class="mt-2 text-lg font-bold">OpenSales POS</div>
        </div>

        <div class="mb-6 text-center">
          <h2 class="text-lg font-semibold">
            {{ mode === 'login' ? 'Tizimga kirish' : mode === 'key' ? 'PINni tiklash' : mode === 'newpin' ? 'Yangi PIN' : mode === 'confirm' ? 'PINni tasdiqlang' : 'Tayyor!' }}
          </h2>
          <p class="mt-0.5 text-sm text-muted-foreground">
            {{ mode === 'login' ? 'PIN-kodni kiriting' : mode === 'key' ? 'Tiklash kalit so\'zi yoki QR' : mode === 'newpin' ? 'Yangi PIN o\'rnating' : mode === 'confirm' ? 'Qaytadan kiriting' : '' }}
          </p>
        </div>

        <template v-if="mode === 'login'">
          <PinPad ref="loginPad" :error="pinError" @complete="onLogin" />
          <button @click="mode = 'key'" class="mx-auto mt-6 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <KeyRound class="h-3.5 w-3.5" /> PIN-kodni unutdingizmi?
          </button>
        </template>

        <template v-else-if="mode === 'key'">
          <input v-model="recoveryKey" autofocus placeholder="Kalit so'z" class="h-11 w-full rounded-lg border bg-background px-3 text-center text-sm" @keyup.enter="checkKey" />
          <div v-if="keyError" class="mt-2 text-center text-sm text-rose-600">{{ keyError }}</div>
          <button @click="checkKey" class="mt-4 h-11 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90">Davom etish</button>
          <button @click="showScanner = true" class="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-lg border text-sm font-medium hover:bg-muted">
            <QrCode class="h-4 w-4" /> QR-kodni skanerlash
          </button>
          <button @click="backToLogin" class="mx-auto mt-4 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft class="h-3.5 w-3.5" /> Orqaga</button>
        </template>

        <PinPad v-else-if="mode === 'newpin'" @complete="onNewPin" />
        <PinPad v-else-if="mode === 'confirm'" ref="confirmPad" :error="confirmError" @complete="onConfirm" />

        <div v-else-if="mode === 'done'" class="flex flex-col items-center gap-2 py-8">
          <div class="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600"><Check class="h-7 w-7" /></div>
          <div class="text-sm font-medium">Yangi PIN o'rnatildi</div>
        </div>
      </div>

      <div class="absolute bottom-5 flex items-center gap-3 text-xs text-muted-foreground lg:hidden">
        <span>v{{ appVersion }}</span>
        <button @click="openSite" class="flex items-center gap-1 hover:text-foreground"><Globe class="h-3 w-3" /> {{ siteLabel }}</button>
      </div>
    </div>

    <QrScanner v-if="showScanner" @decoded="onQrDecoded" @close="showScanner = false" />
  </div>
</template>
