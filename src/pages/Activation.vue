<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ShieldCheck, Copy, Check, Phone } from 'lucide-vue-next'
import { license, refreshLicense, activate, getDeviceId } from '../lib/license'
import LicenseAdmin from '../components/LicenseAdmin.vue'
import logoDark from '../assets/logo-dark.svg'
import { notify } from '../lib/notify'

const router = useRouter()
const deviceId = ref('')
const keyInput = ref('')
const err = ref('')
const busy = ref(false)
const copied = ref(false)
const showAdmin = ref(false)
const logoTaps = ref(0)

const phone = import.meta.env.VITE_SUPPORT_PHONE ?? ''
const supportName = import.meta.env.VITE_SUPPORT_NAME ?? ''

onMounted(async () => {
  await refreshLicense()
  deviceId.value = license.value.deviceId || (await getDeviceId())
  if (license.value.active) router.replace('/pos')
})

async function submit() {
  err.value = ''
  busy.value = true
  const r = await activate(keyInput.value)
  busy.value = false
  if (r.ok) { notify(r.msg, 'success'); router.replace('/pos') }
  else err.value = r.msg
}

async function copyId() {
  try { await navigator.clipboard.writeText(deviceId.value); copied.value = true; setTimeout(() => (copied.value = false), 1500) } catch {}
}

// Logo 5-marta bosilsa egasi generatorini ochish
function tapLogo() { if (++logoTaps.value >= 5) { logoTaps.value = 0; showAdmin.value = true } }
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-background p-6">
    <div class="w-full max-w-md">
      <div class="mb-6 flex flex-col items-center text-center">
        <button @click="tapLogo" class="mb-3 h-16 w-16 overflow-hidden rounded-2xl border bg-black">
          <img :src="logoDark" class="h-full w-full" />
        </button>
        <h1 class="text-xl font-bold">OpenSales POS</h1>
        <p class="mt-1 text-sm text-muted-foreground">Dasturni faollashtirish</p>
      </div>

      <div class="rounded-2xl border bg-card p-5 shadow-sm">
        <div class="mb-4 flex items-center gap-2 rounded-lg bg-rose-500/10 px-3 py-2.5 text-sm text-rose-600">
          <ShieldCheck class="h-4 w-4 shrink-0" />
          <span>{{ license.mode === 'expired' ? 'Aktivlashtirish muddati tugadi. Davom etish uchun kalit kiriting.' : 'Dasturni faollashtiring.' }}</span>
        </div>

        <label class="mb-1 block text-sm font-medium">Qurilma ID</label>
        <div class="mb-4 flex items-center gap-2">
          <div class="flex h-10 flex-1 items-center rounded-lg border bg-muted/40 px-3 font-mono text-sm tabular-nums">{{ deviceId }}</div>
          <button @click="copyId" class="flex h-10 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted">
            <component :is="copied ? Check : Copy" class="h-4 w-4" /> {{ copied ? 'OK' : 'Nusxa' }}
          </button>
        </div>

        <label class="mb-1 block text-sm font-medium">Aktivatsiya kaliti</label>
        <textarea v-model="keyInput" rows="3" placeholder="Sotuvchidan olingan kalitni shu yerga joylang"
          class="w-full resize-none rounded-lg border bg-background px-3 py-2 font-mono text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"></textarea>
        <p v-if="err" class="mt-1.5 text-sm text-rose-500">{{ err }}</p>

        <button @click="submit" :disabled="busy || !keyInput.trim()"
          class="mt-3 h-11 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {{ busy ? 'Tekshirilmoqda…' : 'Faollashtirish' }}
        </button>

        <div v-if="phone" class="mt-4 flex items-center justify-center gap-1.5 border-t pt-4 text-sm text-muted-foreground">
          <Phone class="h-4 w-4" /> Kalit olish uchun: <a :href="`tel:${phone}`" class="font-medium text-foreground">{{ phone }}</a>
          <span v-if="supportName" class="text-muted-foreground">· {{ supportName }}</span>
        </div>
      </div>
    </div>

    <LicenseAdmin v-if="showAdmin" :device-id="deviceId" @close="showAdmin = false" />
  </div>
</template>
