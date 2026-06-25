<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { KeyRound, ArrowLeft, Phone, Info, Check, QrCode } from 'lucide-vue-next'
import { loginPin, verifyRecoveryKey, setPin } from '../lib/auth'
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
const showInfo = ref(false)
const showScanner = ref(false)

async function onQrDecoded(text: string) {
  showScanner.value = false
  if (await verifyRecoveryKey(text)) { keyError.value = ''; mode.value = 'newpin' }
  else keyError.value = "QR-kod mos kelmadi"
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
  <div class="relative flex h-screen flex-col items-center justify-center bg-background p-6 text-foreground">
    <div class="w-full max-w-xs">
      <div class="mb-8 flex flex-col items-center text-center">
        <div class="h-16 w-16 overflow-hidden rounded-2xl shadow-md ring-1 ring-black/10">
          <img :src="logoDark" class="h-full w-full" alt="OpenSales" />
        </div>
        <h1 class="mt-3 text-xl font-bold">OpenSales POS</h1>
        <p class="text-sm text-muted-foreground">
          {{ mode === 'login' ? 'PIN-kodni kiriting' : mode === 'key' ? 'Tiklash kalit so\'zi' : mode === 'newpin' ? 'Yangi PIN o\'rnating' : mode === 'confirm' ? 'Yangi PINni tasdiqlang' : 'Tayyor!' }}
        </p>
      </div>

      <!-- Login -->
      <template v-if="mode === 'login'">
        <PinPad ref="loginPad" :error="pinError" @complete="onLogin" />
        <button @click="mode = 'key'" class="mx-auto mt-6 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <KeyRound class="h-3.5 w-3.5" /> PIN-kodni unutdingizmi?
        </button>
      </template>

      <!-- Recovery key -->
      <template v-else-if="mode === 'key'">
        <input v-model="recoveryKey" autofocus placeholder="Kalit so'z" class="h-11 w-full rounded-lg border bg-background px-3 text-center text-sm" @keyup.enter="checkKey" />
        <div v-if="keyError" class="mt-2 text-center text-sm text-rose-600">{{ keyError }}</div>
        <button @click="checkKey" class="mt-4 h-11 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90">Davom etish</button>
        <button @click="showScanner = true" class="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-lg border text-sm font-medium hover:bg-muted">
          <QrCode class="h-4 w-4" /> QR-kodni skanerlash
        </button>
        <button @click="backToLogin" class="mx-auto mt-4 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft class="h-3.5 w-3.5" /> Orqaga</button>
      </template>

      <!-- New PIN -->
      <PinPad v-else-if="mode === 'newpin'" @complete="onNewPin" />

      <!-- Confirm PIN -->
      <PinPad v-else-if="mode === 'confirm'" ref="confirmPad" :error="confirmError" @complete="onConfirm" />

      <!-- Done -->
      <div v-else-if="mode === 'done'" class="flex flex-col items-center gap-2 py-8">
        <div class="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600"><Check class="h-7 w-7" /></div>
        <div class="text-sm font-medium">Yangi PIN o'rnatildi</div>
      </div>
    </div>

    <!-- Pastki info/contact -->
    <div class="absolute bottom-5 flex items-center gap-4 text-xs text-muted-foreground">
      <button @click="showInfo = true" class="flex items-center gap-1 hover:text-foreground"><Info class="h-3.5 w-3.5" /> Dastur haqida</button>
      <a href="tel:+998902782836" class="flex items-center gap-1 hover:text-foreground"><Phone class="h-3.5 w-3.5" /> +998 90 278 28 36</a>
    </div>

    <!-- QR scanner -->
    <QrScanner v-if="showScanner" @decoded="onQrDecoded" @close="showScanner = false" />

    <!-- Info modal -->
    <div v-if="showInfo" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-sm rounded-xl border bg-card p-6 text-center shadow-xl">
        <div class="mx-auto h-14 w-14 overflow-hidden rounded-2xl shadow ring-1 ring-black/10">
          <img :src="logoDark" class="h-full w-full" />
        </div>
        <div class="mt-3 text-lg font-bold">OpenSales POS</div>
        <div class="text-sm text-muted-foreground">Offline kassa tizimi · v1.0</div>
        <p class="mt-3 text-sm text-muted-foreground">Do'kon va savdo nuqtalari uchun oddiy, tez va internetsiz ishlaydigan kassa dasturi.</p>
        <div class="mt-4 space-y-1 border-t pt-4 text-sm">
          <div class="font-medium">Ilxomjon Abdullayev</div>
          <a href="tel:+998902782836" class="flex items-center justify-center gap-1.5 text-primary"><Phone class="h-4 w-4" /> +998 90 278 28 36</a>
        </div>
        <button @click="showInfo = false" class="mt-5 h-10 w-full rounded-md border text-sm hover:bg-muted">Yopish</button>
      </div>
    </div>
  </div>
</template>
