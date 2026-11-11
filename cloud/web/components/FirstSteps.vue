<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { BellRing, Check, Mic, Plus, ShoppingBag, X } from 'lucide-vue-next'
import { session, isOwner, allowBotMessages, type ShopProgress } from '../session'
import { call } from '../rpc'
import { can } from '../lib/auth'
import { dataVersion } from '../freshness'
import { assistant, openAssistant } from '../assistant'
import { canRequestWriteAccess, haptic } from '../telegram'

// Yangi do'kon uchun "Boshlash" (varonka, 2026-11-10): 1) tovar qo'shish (ovoz yoki qo'lda), 2) birinchi sotuv.
// Birinchi sotuvdan keyin yo'qoladi; ega yopsa — shu do'kon uchun qayta chiqmaydi. Kassa va Mahsulotlarda.
const route = useRoute()
const router = useRouter()
const key = () => `kassa:firstSteps:${session.shop?.id ?? '-'}`
const dismissed = ref((() => { try { return localStorage.getItem(key()) === '1' } catch { return false } })())

const p = computed(() => session.progress)
const show = computed(() =>
  session.status === 'ok' && !session.view && isOwner() && !dismissed.value && !!p.value && p.value.sales === 0
  && ['/pos', '/products'].includes(route.path))

// Yozuvdan keyin (tovar qo'shildi, sotildi) holat yangilanadi — karta o'zi oldinga siljiydi.
async function refresh() {
  if (!session.progress || session.view) return
  try { session.progress = await call<ShopProgress>('shopProgress', []) } catch { /* keyingi yozuvda */ }
}
watch(() => [dataVersion.value, assistant.version], () => { if (session.progress && session.progress.sales === 0) void refresh() })

function close() {
  dismissed.value = true
  haptic('select')
  try { localStorage.setItem(key(), '1') } catch { /* */ }
}
function voice() { haptic('select'); openAssistant() }
function manual() { haptic('select'); void router.push({ path: '/products', query: { new: '1' } }) }
function toPos() { haptic('select'); void router.push('/pos') }

// Bot unga yoza olmaydi (ilova reklamadan to'g'ridan ochilgan, /start yo'q) — eslatma/Excel yetmaydi.
const askPm = computed(() => session.pm === false && canRequestWriteAccess())
const asking = ref(false)
async function allowPm() {
  if (asking.value) return
  asking.value = true
  haptic('select')
  try { if (await allowBotMessages()) haptic('success') } finally { asking.value = false }
}
</script>

<template>
  <section v-if="show && p" class="fs-card">
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold">{{ $t('cloud.firstSteps.title') }}</div>
        <div class="text-xs text-muted-foreground">{{ $t('cloud.firstSteps.subtitle') }}</div>
      </div>
      <button type="button" class="fs-x" :aria-label="$t('common.close')" @click="close"><X class="h-4 w-4" /></button>
    </div>

    <div class="fs-step" :class="{ done: p.products > 0 }">
      <span class="fs-dot"><Check v-if="p.products > 0" class="h-3.5 w-3.5" /><template v-else>1</template></span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium">{{ p.products > 0 ? $t('cloud.firstSteps.productsDone', { n: p.products }) : $t('cloud.firstSteps.addProducts') }}</div>
        <template v-if="p.products === 0">
          <div v-if="session.ai" class="text-xs text-muted-foreground">{{ $t('cloud.firstSteps.voiceHint') }}</div>
          <div class="mt-2 flex gap-2">
            <button v-if="session.ai" type="button" class="fs-btn primary" @click="voice"><Mic class="h-4 w-4" />{{ $t('cloud.firstSteps.voice') }}</button>
            <button v-if="can('catalogEdit')" type="button" class="fs-btn" @click="manual"><Plus class="h-4 w-4" />{{ $t('cloud.firstSteps.manual') }}</button>
          </div>
        </template>
      </div>
    </div>

    <div class="fs-step">
      <span class="fs-dot">2</span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium">{{ $t('cloud.firstSteps.firstSale') }}</div>
        <div class="text-xs text-muted-foreground">{{ $t('cloud.firstSteps.saleHint') }}</div>
        <button v-if="p.products > 0 && route.path !== '/pos'" type="button" class="fs-btn primary mt-2" @click="toPos"><ShoppingBag class="h-4 w-4" />{{ $t('cloud.firstSteps.toPos') }}</button>
      </div>
    </div>

    <div v-if="askPm" class="fs-step fs-bot">
      <span class="fs-dot"><BellRing class="h-3.5 w-3.5" /></span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium">{{ $t('cloud.firstSteps.botTitle') }}</div>
        <div class="text-xs text-muted-foreground">{{ $t('cloud.firstSteps.botHint') }}</div>
        <button type="button" class="fs-btn mt-2" :disabled="asking" @click="allowPm"><BellRing class="h-4 w-4" />{{ $t('cloud.firstSteps.botAllow') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.fs-card {
  flex: none;
  margin: 0.5rem 1rem 0;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 1rem;
  background: var(--card);
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}
.fs-x {
  display: grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  flex: none;
  border-radius: 9999px;
  color: var(--muted-foreground);
}
.fs-step {
  display: flex;
  gap: 0.625rem;
}
.fs-bot {
  padding-top: 0.625rem;
  border-top: 1px solid var(--border);
}
.fs-step.done {
  opacity: 0.6;
}
.fs-dot {
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  flex: none;
  border-radius: 9999px;
  background: var(--muted);
  font-size: 0.75rem;
  font-weight: 700;
}
.fs-step.done .fs-dot {
  background: var(--primary);
  color: var(--primary-foreground);
}
.fs-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  height: 2.25rem;
  padding: 0 0.875rem;
  border: 1px solid var(--border);
  border-radius: 9999px;
  font-size: 0.8125rem;
  font-weight: 600;
}
.fs-btn.primary {
  border-color: transparent;
  background: var(--primary);
  color: var(--primary-foreground);
}
</style>
