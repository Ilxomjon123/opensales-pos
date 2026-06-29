<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { lastRoute } from '../router'
import { KeyRound, ArrowLeft, Check, QrCode, Wifi, ShieldCheck, Printer, Globe } from 'lucide-vue-next'
import { openUrl } from '@tauri-apps/plugin-opener'
import { loginPin, verifyRecoveryKey, setPin, isDefaultPin, defaultPin } from '../lib/auth'
import { appVersion } from '../lib/version'
import PinPad from '../components/PinPad.vue'
import QrScanner from '../components/QrScanner.vue'
import logoDark from '../assets/logo-dark.svg'
import { useI18n } from 'vue-i18n'
import { setLocale, availableLocales, type Locale } from '../lib/i18n'

const { locale, t } = useI18n()
function changeLocale(l: Locale) { setLocale(l) }

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

// PIN hali boshlang'ich bo'lsa — login PIN-padi yonida maslahat ko'rsatamiz.
const showPinHint = ref(false)
onMounted(async () => { showPinHint.value = await isDefaultPin() })

const phone = import.meta.env.VITE_SUPPORT_PHONE ?? ''
const supportName = import.meta.env.VITE_SUPPORT_NAME ?? ''
const site = (import.meta.env.VITE_SITE_URL ?? 'https://opensales.uz') as string
const siteLabel = site.replace(/^https?:\/\//, '')
function openSite() { openUrl(site).catch(() => {}) }

async function onQrDecoded(text: string) {
  showScanner.value = false
  if (await verifyRecoveryKey(text)) { keyError.value = ''; mode.value = 'newpin' }
  else keyError.value = t('login.qrMismatch')
}
async function onLogin(p: string) {
  if (await loginPin(p)) router.push(lastRoute())
  else { pinError.value = true; loginPad.value?.shakeNow(); setTimeout(() => (pinError.value = false), 600) }
}
async function checkKey() {
  keyError.value = ''
  if (await verifyRecoveryKey(recoveryKey.value)) { mode.value = 'newpin' }
  else keyError.value = t('login.keyWrong')
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
            <div class="mt-1 text-xs text-muted-foreground">{{ $t('login.tagline') }}</div>
          </div>
        </div>

        <h1 class="mt-9 text-[2.1rem] leading-[1.12] font-semibold tracking-tight">
          {{ $t('login.heroTitle') }}
        </h1>
        <p class="mt-3.5 text-sm leading-relaxed text-muted-foreground">
          {{ $t('login.heroSubtitle') }}
        </p>

        <div class="mt-8 space-y-2.5">
          <div class="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-sm shadow-sm">
            <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-foreground"><Wifi class="h-4 w-4" /></span> {{ $t('login.featureOffline') }}
          </div>
          <div class="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-sm shadow-sm">
            <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-foreground"><Printer class="h-4 w-4" /></span> {{ $t('login.featurePrint') }}
          </div>
          <div class="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-sm shadow-sm">
            <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-foreground"><ShieldCheck class="h-4 w-4" /></span> {{ $t('login.featurePin') }}
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
      <!-- Til toggle (burchak) -->
      <div class="absolute top-5 right-6 flex items-center gap-1 text-xs">
        <button v-for="l in availableLocales" :key="l.code" @click="changeLocale(l.code)" class="rounded-md px-2 py-1 font-medium transition-colors" :class="locale === l.code ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'">{{ l.code.toUpperCase() }}</button>
      </div>

      <div class="w-full max-w-xs">
        <!-- Kichik ekranda logo -->
        <div class="mb-8 flex flex-col items-center text-center lg:hidden">
          <div class="h-14 w-14 overflow-hidden rounded-2xl shadow-md ring-1 ring-black/10"><img :src="logoDark" class="h-full w-full" /></div>
          <div class="mt-2 text-lg font-bold">OpenSales POS</div>
        </div>

        <div class="mb-6 text-center">
          <h2 class="text-lg font-semibold">
            {{ mode === 'login' ? $t('login.title') : mode === 'key' ? $t('login.resetTitle') : mode === 'newpin' ? $t('login.newPinTitle') : mode === 'confirm' ? $t('login.confirmTitle') : $t('login.doneTitle') }}
          </h2>
          <p class="mt-0.5 text-sm text-muted-foreground">
            {{ mode === 'login' ? $t('login.subtitle') : mode === 'key' ? $t('login.resetSubtitle') : mode === 'newpin' ? $t('login.newPinSubtitle') : mode === 'confirm' ? $t('login.confirmSubtitle') : '' }}
          </p>
        </div>

        <template v-if="mode === 'login'">
          <div v-if="showPinHint" class="mb-4 flex items-start gap-2.5 rounded-lg border bg-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <KeyRound class="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{{ $t('login.defaultPinHintBefore') }}<span class="font-semibold text-foreground">{{ defaultPin }}</span>{{ $t('login.defaultPinHintAfter') }}</span>
          </div>
          <PinPad ref="loginPad" :error="pinError" @complete="onLogin" />
          <button @click="mode = 'key'" class="mx-auto mt-6 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <KeyRound class="h-3.5 w-3.5" /> {{ $t('login.forgotPin') }}
          </button>
        </template>

        <template v-else-if="mode === 'key'">
          <input v-model="recoveryKey" autofocus :placeholder="$t('login.keyPlaceholder')" class="h-11 w-full rounded-lg border bg-background px-3 text-center text-sm" @keyup.enter="checkKey" />
          <div v-if="keyError" class="mt-2 text-center text-sm text-rose-600">{{ keyError }}</div>
          <button @click="checkKey" class="mt-4 h-11 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90">{{ $t('login.continue') }}</button>
          <button @click="showScanner = true" class="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-lg border text-sm font-medium hover:bg-muted">
            <QrCode class="h-4 w-4" /> {{ $t('login.scanQr') }}
          </button>
          <button @click="backToLogin" class="mx-auto mt-4 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft class="h-3.5 w-3.5" /> {{ $t('common.back') }}</button>
        </template>

        <PinPad v-else-if="mode === 'newpin'" @complete="onNewPin" />
        <PinPad v-else-if="mode === 'confirm'" ref="confirmPad" :error="confirmError" @complete="onConfirm" />

        <div v-else-if="mode === 'done'" class="flex flex-col items-center gap-2 py-8">
          <div class="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600"><Check class="h-7 w-7" /></div>
          <div class="text-sm font-medium">{{ $t('login.pinSet') }}</div>
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
