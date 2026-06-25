<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { KeyRound, ArrowLeft, Check, QrCode, Wifi, ShieldCheck, Printer, Globe } from 'lucide-vue-next'
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
  <div class="flex h-screen bg-background text-foreground">
    <!-- Chap: dastur haqida -->
    <div class="relative hidden flex-1 flex-col items-center justify-center border-r bg-muted/30 px-16 lg:order-1 lg:flex">
      <div class="w-full max-w-md">
        <div class="flex items-center gap-3">
          <div class="h-11 w-11 overflow-hidden rounded-xl ring-1 ring-black/10"><img :src="logoDark" class="h-full w-full" /></div>
          <div>
            <div class="text-base font-semibold leading-none tracking-tight">OpenSales POS</div>
            <div class="mt-1 text-xs text-muted-foreground">Offline kassa tizimi</div>
          </div>
        </div>

        <h1 class="mt-9 text-[2.1rem] leading-[1.12] font-semibold tracking-tight">
          Do'koningiz uchun zamonaviy kassa
        </h1>
        <p class="mt-3.5 text-sm leading-relaxed text-muted-foreground">
          Sotuv, ombor, mijozlar va qarzlar — bir joyda. Internetsiz, tez va ishonchli ishlaydi.
        </p>

        <div class="mt-8 space-y-2.5">
          <div class="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-sm shadow-sm">
            <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-foreground"><Wifi class="h-4 w-4" /></span> To'liq offline — internet shart emas
          </div>
          <div class="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-sm shadow-sm">
            <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-foreground"><Printer class="h-4 w-4" /></span> Chek chop etish
          </div>
          <div class="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-sm shadow-sm">
            <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-foreground"><ShieldCheck class="h-4 w-4" /></span> PIN-kod bilan himoya
          </div>
        </div>

        <div class="mt-7 flex items-center justify-between rounded-xl border bg-card px-4 py-3.5 shadow-sm">
          <div class="text-sm">
            <div class="font-medium">{{ supportName || 'Ilxomjon Abdullayev' }}</div>
            <a v-if="phone" :href="`tel:${phone}`" class="text-muted-foreground hover:text-foreground">{{ phone }}</a>
          </div>
          <button @click="openSite" class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted"><Globe class="h-3.5 w-3.5" /> {{ siteLabel }}</button>
        </div>
      </div>

      <div class="absolute bottom-6 left-16 text-xs text-muted-foreground/70">v{{ appVersion }}</div>
    </div>

    <!-- O'ng: PIN (minimal kenglik) -->
    <div class="relative flex w-full flex-col items-center justify-center px-6 lg:order-2 lg:w-[420px] lg:shrink-0">
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
