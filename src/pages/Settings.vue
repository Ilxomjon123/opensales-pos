<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Check, Store, Coins, ShoppingCart, ShieldCheck, KeyRound, Copy, FileText } from 'lucide-vue-next'
import { getSetting, setSetting } from '../lib/db'
import { setCurrency } from '../lib/format'
import { license, refreshLicense, activate } from '../lib/license'
import LicenseAdmin from '../components/LicenseAdmin.vue'
import LogViewer from '../components/LogViewer.vue'
import { notify } from '../lib/notify'

const currency = ref("so'm")
const allowNegative = ref(false)
const shopName = ref('OpenSales POS')
const newPin = ref('')
const pinError = ref('')
const saved = ref(false)

const licKey = ref('')
const showAdmin = ref(false)
const keyTaps = ref(0)
function tapKey() { if (++keyTaps.value >= 5) { keyTaps.value = 0; showAdmin.value = true } }
const showLogs = ref(false)
const licText = computed(() => {
  const l = license.value
  if (l.mode === 'licensed') return l.forever ? 'Faol · cheksiz' : `Faol · ${l.until} gacha (${l.daysLeft} kun)`
  if (l.mode === 'trial') return `Sinov muddati · ${l.daysLeft} kun qoldi`
  return 'Muddati tugagan'
})

onMounted(async () => {
  currency.value = await getSetting('currency_symbol', "so'm")
  allowNegative.value = (await getSetting('allow_negative_stock', '0')) === '1'
  shopName.value = await getSetting('shop_name', 'OpenSales POS')
  await refreshLicense()
})

async function applyKey() {
  const r = await activate(licKey.value)
  notify(r.msg, r.ok ? 'success' : 'error')
  if (r.ok) licKey.value = ''
}
async function copyDevice() { try { await navigator.clipboard.writeText(license.value.deviceId); notify('Nusxalandi', 'success') } catch {} }

async function save() {
  pinError.value = ''
  if (newPin.value.trim()) {
    if (!/^\d{4}$/.test(newPin.value.trim())) { pinError.value = "4 ta raqam bo'lishi kerak"; return }
    await setSetting('auth_pin', newPin.value.trim())
    newPin.value = ''
  }
  await setSetting('currency_symbol', currency.value || "so'm")
  await setSetting('allow_negative_stock', allowNegative.value ? '1' : '0')
  await setSetting('shop_name', shopName.value || 'OpenSales POS')
  setCurrency(currency.value)
  saved.value = true
  setTimeout(() => (saved.value = false), 2000)
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <div>
        <h1 class="text-lg font-semibold">Sozlamalar</h1>
        <p class="text-sm text-muted-foreground">Do'kon va tizim parametrlari</p>
      </div>
      <div class="flex items-center gap-3">
        <span v-if="saved" class="flex items-center gap-1 text-sm text-emerald-600"><Check class="h-4 w-4" /> Saqlandi</span>
        <button @click="showLogs = true" class="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted"><FileText class="h-4 w-4" /> Loglar</button>
        <button @click="save" class="h-9 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90">Saqlash</button>
      </div>
    </header>

    <div class="flex-1 overflow-auto p-6">
      <div class="mx-auto grid max-w-4xl gap-5 lg:grid-cols-2">
        <!-- Do'kon -->
        <section class="rounded-xl border bg-card p-5">
          <div class="mb-4 flex items-center gap-2 text-sm font-semibold"><Store class="h-4 w-4 text-primary" /> Do'kon</div>
          <div class="space-y-4">
            <div>
              <label class="mb-1.5 block text-sm font-medium">Do'kon nomi</label>
              <input v-model="shopName" class="h-10 w-full rounded-lg border bg-background px-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
              <p class="mt-1 text-xs text-muted-foreground">Chek va dastur sarlavhasida ko'rinadi</p>
            </div>
          </div>
        </section>

        <!-- Valyuta -->
        <section class="rounded-xl border bg-card p-5">
          <div class="mb-4 flex items-center gap-2 text-sm font-semibold"><Coins class="h-4 w-4 text-primary" /> Valyuta</div>
          <label class="mb-1.5 block text-sm font-medium">Belgisi</label>
          <input v-model="currency" placeholder="so'm" class="h-10 w-full rounded-lg border bg-background px-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
          <div class="mt-3 flex gap-1.5">
            <button v-for="c in [`so'm`, '₽', '$', '€']" :key="c" @click="currency = c" class="rounded-md border px-3 py-1 text-sm hover:bg-muted" :class="currency === c ? 'border-primary bg-primary/10 text-primary' : ''">{{ c }}</button>
          </div>
        </section>

        <!-- Sotuv -->
        <section class="rounded-xl border bg-card p-5">
          <div class="mb-4 flex items-center gap-2 text-sm font-semibold"><ShoppingCart class="h-4 w-4 text-primary" /> Sotuv</div>
          <label class="flex items-center justify-between gap-4">
            <div>
              <div class="text-sm font-medium">Ostatkasiz sotish</div>
              <div class="text-xs text-muted-foreground">Qoldiq 0 bo'lsa ham sotishga ruxsat</div>
            </div>
            <button type="button" @click="allowNegative = !allowNegative" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="allowNegative ? 'bg-primary' : 'bg-muted'">
              <span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform" :class="allowNegative ? 'translate-x-5' : ''"></span>
            </button>
          </label>
        </section>

        <!-- Xavfsizlik -->
        <section class="rounded-xl border bg-card p-5">
          <div class="mb-4 flex items-center gap-2 text-sm font-semibold"><ShieldCheck class="h-4 w-4 text-primary" /> Xavfsizlik</div>
          <label class="mb-1.5 block text-sm font-medium">Yangi PIN-kod</label>
          <input v-model="newPin" inputmode="numeric" maxlength="4" placeholder="• • • •" class="h-10 w-32 rounded-lg border bg-background px-3 text-center text-sm tracking-[0.4em] focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
          <p class="mt-1 text-xs text-muted-foreground">O'zgartirmaslik uchun bo'sh qoldiring</p>
          <div v-if="pinError" class="mt-1 text-xs text-rose-600">{{ pinError }}</div>
        </section>

        <!-- Litsenziya -->
        <section class="rounded-xl border bg-card p-5 lg:col-span-2">
          <div class="mb-4 flex items-center justify-between">
            <div class="flex items-center gap-2 text-sm font-semibold"><button @click="tapKey" class="rounded p-0.5"><KeyRound class="h-4 w-4 text-primary" /></button> Litsenziya</div>
            <span class="rounded-full px-2.5 py-0.5 text-xs font-medium"
              :class="license.mode === 'licensed' ? 'bg-emerald-500/15 text-emerald-600' : license.mode === 'trial' ? 'bg-amber-500/15 text-amber-600' : 'bg-rose-500/15 text-rose-600'">{{ licText }}</span>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="mb-1.5 block text-sm font-medium">Qurilma ID</label>
              <div class="flex items-center gap-2">
                <div class="flex h-10 flex-1 items-center rounded-lg border bg-muted/40 px-3 font-mono text-sm tabular-nums">{{ license.deviceId }}</div>
                <button @click="copyDevice" class="flex h-10 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted"><Copy class="h-4 w-4" /></button>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">Yangi kalit olish uchun sotuvchiga shu ID ni yuboring</p>
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-medium">Aktivatsiya kaliti</label>
              <div class="flex items-center gap-2">
                <input v-model="licKey" placeholder="Kalitni joylang" class="h-10 flex-1 rounded-lg border bg-background px-3 font-mono text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
                <button @click="applyKey" :disabled="!licKey.trim()" class="h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">Faollashtirish</button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <LicenseAdmin v-if="showAdmin" :device-id="license.deviceId" @close="showAdmin = false" />
    <LogViewer v-if="showLogs" @close="showLogs = false" />
  </div>
</template>
