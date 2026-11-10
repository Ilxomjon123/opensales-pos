<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Search, Store, Ban, CircleCheck, CalendarPlus, Users, Crown, Sparkles, Eye, Loader2 } from 'lucide-vue-next'
import GlassSheet from '../components/GlassSheet.vue'
import GlassDate from '../components/GlassDate.vue'
import { api, RpcError } from '../rpc'
import { viewShop } from '../session'
import { haptic } from '../telegram'
import { notify } from '../../../src/lib/notify'
import { confirmDialog } from '../../../src/lib/confirm'
import { translitMatch } from '../../../src/lib/format'

// Platforma admini (ADMIN_CHAT_ID): barcha do'konlar, obunani uzaytirish, bloklash. Bot chatidagi
// /tenants, /extend, /block buyruqlarining ilovadagi ko'rinishi — server ikkalasida bir xil tekshiradi.
type State = 'trial' | 'paid' | 'expired' | 'blocked'
type Tenant = {
  id: string; name: string; owner_uid: number; owner_username: string | null; members: number
  trial_until: string; paid_until: string | null; created_at: string; state: State; until: string; own: boolean; ai: boolean
}
type Filter = 'all' | 'active' | 'expired' | 'blocked'

const { t } = useI18n()
const rows = ref<Tenant[]>([])
const loading = ref(true)
const q = ref('')
const filter = ref<Filter>('all')
const picked = ref<Tenant | null>(null)
const customDay = ref('')
const busy = ref(false)

function fail(e: unknown) {
  notify(e instanceof RpcError ? t(e.code, e.params) : String(e), 'error')
}
async function load() {
  try { rows.value = await api<Tenant[]>('/api/admin/tenants') } catch (e) { fail(e) } finally { loading.value = false }
}
onMounted(load)

const counts = computed(() => ({
  all: rows.value.length,
  active: rows.value.filter((r) => r.state === 'trial' || r.state === 'paid').length,
  expired: rows.value.filter((r) => r.state === 'expired').length,
  blocked: rows.value.filter((r) => r.state === 'blocked').length,
}))
const shown = computed(() => rows.value.filter((r) => {
  if (filter.value === 'active' && !(r.state === 'trial' || r.state === 'paid')) return false
  if (filter.value !== 'all' && filter.value !== 'active' && r.state !== filter.value) return false
  const s = q.value.trim()
  return !s || translitMatch(`${r.name} ${r.owner_username ?? ''} ${r.owner_uid} ${r.id.slice(0, 8)}`, s)
}))

// Sanalar Toshkent kuni bo'yicha (server muddatni Toshkent kuni oxirigacha yozadi).
const TZ_MS = 5 * 3600_000
const tashDay = (iso: string) => new Date(Date.parse(iso) + TZ_MS).toISOString().slice(0, 10)
const fmtDay = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`
const today = () => tashDay(new Date().toISOString())
/** Tez uzaytirish: muddat hali tugamagan bo'lsa — muddatdan, tugagan bo'lsa — bugundan. */
function plusMonths(r: Tenant, months: number): string {
  const base = [tashDay(r.until), today()].sort().pop()!
  const d = new Date(`${base}T00:00:00Z`)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.toISOString().slice(0, 10)
}
const QUICK = [1, 3, 6, 12] as const

function open(r: Tenant) {
  picked.value = r
  customDay.value = ''
  haptic('select')
}
function replace(r: Tenant | null) {
  if (!r) return load()
  rows.value = rows.value.map((x) => (x.id === r.id ? r : x))
  picked.value = r
}
async function extend(day: string) {
  const r = picked.value
  if (!r || !day || busy.value) return
  busy.value = true
  try {
    replace(await api<Tenant | null>('/api/admin/extend', { id: r.id, until: day }))
    customDay.value = ''
    haptic('success')
    notify(t('cloud.admin.extended', { name: r.name, date: fmtDay(day) }), 'success')
  } catch (e) { fail(e) } finally { busy.value = false }
}
async function setBlocked(blocked: boolean) {
  const r = picked.value
  if (!r || busy.value) return
  if (blocked && !(await confirmDialog(t('cloud.admin.blockConfirm', { name: r.name }), { danger: true }))) return
  busy.value = true
  try {
    replace(await api<Tenant | null>('/api/admin/status', { id: r.id, status: blocked ? 'blocked' : 'active' }))
    haptic('success')
    notify(t(blocked ? 'cloud.admin.blockedDone' : 'cloud.admin.unblockedDone', { name: r.name }), 'success')
  } catch (e) { fail(e) } finally { busy.value = false }
}

async function setAi(on: boolean) {
  const r = picked.value
  if (!r || busy.value || r.ai === on) return
  busy.value = true
  try {
    replace(await api<Tenant | null>('/api/admin/ai', { id: r.id, enabled: on }))
    haptic('success')
  } catch (e) { fail(e) } finally { busy.value = false }
}

// Do'kon ichini ko'rish (faqat o'qish): ilova shu do'kon bilan qayta ochiladi, tepada «Chiqish» banneri.
const entering = ref(false)
async function enter() {
  const r = picked.value
  if (!r || entering.value) return
  entering.value = true
  haptic('select')
  try { await viewShop(r.id) } catch (e) { entering.value = false; notify(t((e as Error & { params?: Record<string, unknown> }).message || 'cloud.errors.internal'), 'error') }
}

const BADGE: Record<State, string> = {
  trial: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  paid: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  expired: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  blocked: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
}
</script>

<template>
  <div class="min-h-full">
    <header class="page-header">
      <h1 class="text-lg font-semibold">{{ $t('cloud.admin.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ $t('cloud.admin.subtitle') }}</p>
    </header>

    <div class="mx-auto max-w-xl space-y-3 p-4">
      <!-- Holat bo'yicha filtr: soni bilan -->
      <div class="adm-chips">
        <button v-for="f in (['all', 'active', 'expired', 'blocked'] as const)" :key="f" type="button"
          :class="{ on: filter === f }" @click="filter = f; haptic('select')">
          {{ $t(`cloud.admin.filter.${f}`) }} <b>{{ counts[f] }}</b>
        </button>
      </div>

      <label class="adm-search">
        <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
        <input v-model="q" type="search" :placeholder="$t('cloud.admin.search')" />
      </label>

      <section class="os-list !m-0 divide-y rounded-2xl border bg-card">
        <div v-if="loading" class="space-y-2 p-4">
          <div v-for="i in 4" :key="i" class="h-12 animate-pulse rounded-lg bg-muted" />
        </div>
        <button v-for="r in shown" v-else :key="r.id" type="button" class="flex w-full items-center gap-3 p-4 text-left active:bg-muted/40" @click="open(r)">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Store class="h-[18px] w-[18px]" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 text-sm font-semibold">
              <span class="truncate">{{ r.name }}</span>
              <span v-if="r.own" class="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{{ $t('cloud.admin.you') }}</span>
              <span v-if="!r.ai" class="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{{ $t('cloud.admin.aiOffBadge') }}</span>
            </div>
            <div class="truncate text-xs text-muted-foreground">
              {{ r.owner_username ? '@' + r.owner_username : r.owner_uid }} · {{ $t('cloud.admin.members', { n: r.members }) }}
            </div>
          </div>
          <div class="shrink-0 text-right">
            <span class="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold" :class="BADGE[r.state]">{{ $t(`cloud.admin.state.${r.state}`) }}</span>
            <div class="mt-1 text-[11px] tabular-nums text-muted-foreground">{{ $t('cloud.admin.until', { date: fmtDay(tashDay(r.until)) }) }}</div>
          </div>
        </button>
        <div v-if="!loading && !shown.length" class="p-6 text-center text-sm text-muted-foreground">{{ $t('cloud.admin.empty') }}</div>
      </section>

      <p class="px-1 text-center text-xs text-muted-foreground">{{ $t('cloud.admin.botHint') }}</p>
    </div>

    <GlassSheet :open="!!picked" :title="picked?.name" :sub="picked ? `${picked.id.slice(0, 8)} · ${$t(`cloud.admin.state.${picked.state}`)}` : ''" @close="picked = null">
      <div v-if="picked" class="space-y-4 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <button v-if="!picked.own" type="button" class="adm-enter" :disabled="entering" @click="enter">
          <Loader2 v-if="entering" class="h-4 w-4 animate-spin" /><Eye v-else class="h-4 w-4" /> {{ $t('cloud.admin.view') }}
        </button>

        <div class="grid grid-cols-2 gap-2 text-sm">
          <div class="adm-fact"><Crown class="h-4 w-4" /><span class="truncate">{{ picked.owner_username ? '@' + picked.owner_username : picked.owner_uid }}</span></div>
          <div class="adm-fact"><Users class="h-4 w-4" />{{ $t('cloud.admin.members', { n: picked.members }) }}</div>
          <div class="adm-fact col-span-2 justify-between">
            <span class="text-muted-foreground">{{ $t('cloud.admin.created') }}</span>
            <span class="tabular-nums">{{ fmtDay(tashDay(picked.created_at)) }}</span>
          </div>
          <div class="adm-fact col-span-2 justify-between">
            <span class="text-muted-foreground">{{ $t('cloud.admin.subUntil') }}</span>
            <span class="font-semibold tabular-nums">{{ fmtDay(tashDay(picked.until)) }}</span>
          </div>
        </div>

        <div>
          <div class="mb-2 flex items-center gap-1.5 text-sm font-semibold"><CalendarPlus class="h-4 w-4" /> {{ $t('cloud.admin.extendTitle') }}</div>
          <div class="grid grid-cols-4 gap-2">
            <button v-for="m in QUICK" :key="m" type="button" class="adm-quick" :disabled="busy" @click="extend(plusMonths(picked, m))">
              <b>{{ $t(`cloud.admin.plus.${m}`) }}</b>
              <span>{{ fmtDay(plusMonths(picked, m)).slice(0, 5) }}</span>
            </button>
          </div>
          <div class="mt-2 flex items-center gap-2">
            <GlassDate v-model="customDay" :min="today()" class="flex-1" />
            <button type="button" class="adm-save" :disabled="!customDay || busy" @click="extend(customDay)">{{ $t('cloud.admin.save') }}</button>
          </div>
        </div>

        <div>
          <div class="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Sparkles class="h-4 w-4" /> {{ $t('cloud.admin.ai') }}</div>
          <div class="adm-seg" role="radiogroup">
            <button type="button" role="radio" :aria-checked="picked.ai" :class="{ on: picked.ai }" :disabled="busy" @click="setAi(true)">{{ $t('cloud.admin.aiOn') }}</button>
            <button type="button" role="radio" :aria-checked="!picked.ai" :class="{ on: !picked.ai }" :disabled="busy" @click="setAi(false)">{{ $t('cloud.admin.aiOff') }}</button>
          </div>
          <p class="mt-1.5 text-xs text-muted-foreground">{{ $t('cloud.admin.aiHint') }}</p>
        </div>

        <button v-if="picked.state !== 'blocked'" type="button" class="adm-danger" :disabled="busy || picked.own" @click="setBlocked(true)">
          <Ban class="h-4 w-4" /> {{ $t('cloud.admin.block') }}
        </button>
        <button v-else type="button" class="adm-ok" :disabled="busy" @click="setBlocked(false)">
          <CircleCheck class="h-4 w-4" /> {{ $t('cloud.admin.unblock') }}
        </button>
        <p v-if="picked.own && picked.state !== 'blocked'" class="-mt-2 text-center text-xs text-muted-foreground">{{ $t('cloud.admin.errors.ownShop') }}</p>
      </div>
    </GlassSheet>
  </div>
</template>

<style scoped>
.adm-chips {
  display: flex;
  gap: 0.5rem;
  overflow-x: auto;
  scrollbar-width: none;
}
.adm-chips button {
  flex: none;
  height: 2.25rem;
  padding: 0 0.875rem;
  border-radius: 9999px;
  font-size: 0.8125rem;
  font-weight: 500;
}
.adm-chips button b {
  margin-left: 0.25rem;
  font-weight: 700;
  opacity: 0.6;
}
.adm-chips button.on {
  background: var(--primary);
  color: var(--primary-foreground);
}
.adm-chips button.on b {
  opacity: 0.85;
}
.adm-search {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2.75rem;
  padding: 0 0.875rem;
  border: 1px solid var(--border);
  border-radius: 9999px;
  background: var(--card);
}
.adm-search input {
  min-width: 0;
  flex: 1;
  background: transparent;
  font-size: 0.875rem;
  outline: none;
}
.adm-fact {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.625rem 0.75rem;
  border-radius: 0.875rem;
  background: var(--accent);
}
.adm-quick {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.125rem;
  padding: 0.5rem 0.25rem;
  border-radius: 0.875rem;
  font-size: 0.8125rem;
}
.adm-quick span {
  font-size: 0.6875rem;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
.adm-save {
  flex: none;
  height: 2.75rem;
  padding: 0 1.1rem;
  border-radius: 9999px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 0.875rem;
  font-weight: 600;
}
.adm-seg {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 9999px;
  background: var(--secondary);
}
.adm-seg button {
  height: 2.25rem;
  border-radius: 9999px;
  background: transparent;
  box-shadow: none;
  color: var(--muted-foreground);
  font-size: 0.875rem;
  font-weight: 600;
  transition: background-color 0.15s, color 0.15s;
}
.adm-seg button.on {
  background: var(--primary);
  color: var(--primary-foreground);
}
.adm-enter {
  display: flex;
  width: 100%;
  height: 2.75rem;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  border-radius: 9999px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 0.875rem;
  font-weight: 600;
}
.adm-danger,
.adm-ok {
  display: flex;
  width: 100%;
  height: 2.75rem;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  border-radius: 9999px;
  font-size: 0.875rem;
  font-weight: 600;
}
.adm-danger {
  color: var(--color-rose-600);
}
.adm-ok {
  color: var(--color-emerald-600);
}
:is(.adm-save, .adm-danger, .adm-ok, .adm-quick, .adm-enter):disabled {
  opacity: 0.4;
}
</style>
