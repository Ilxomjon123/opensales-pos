<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, ArrowLeft, Plus, Search, Trash2, Truck, Loader2, Clock, CheckCircle2 } from 'lucide-vue-next'
import GlassSheet from '../components/GlassSheet.vue'
import GlassSelect from '../components/GlassSelect.vue'
import { api, RpcError } from '../rpc'
import { session, ownedShops } from '../session'
import { listProducts, type Product } from '../lib/db'
import { haptic } from '../telegram'
import { moneySum, formatDateTime, translitMatch } from '../../../src/lib/format'
import { notify } from '../../../src/lib/notify'
import { bumpData } from '../freshness'

// Do'konlararo ko'chirish (ega, bitta biznes ichida). Manbada chiqim, qabulda kirim — server ikki bosqichda,
// bitta id bilan bajaradi (tarmoq uzilsa o'sha id bilan qayta yuborilsa ikkinchi marta yozilmaydi).
type Line = { productId: number; name: string; unit: string; qty: number; cost: number; price: number; barcode: string | null; targetProductId: number | null }
type Transfer = { id: string; direction: 'out' | 'in'; peer_name: string; status: 'pending' | 'done'; items: Line[]; total_cost: number; note: string | null; user_name: string | null; created_at: string }

const { t } = useI18n()
const rows = ref<Transfer[]>([])
const loading = ref(true)
const expanded = ref<string | null>(null)

function fail(e: unknown) {
  notify(e instanceof RpcError ? t(e.code, e.params) : String(e), 'error')
}
async function load() {
  try { rows.value = await api<Transfer[]>('/api/transfers/list') } catch (e) { fail(e) } finally { loading.value = false }
}
onMounted(load)

// ---- Yangi ko'chirish ----
const open = ref(false)
const targets = computed(() => ownedShops().filter((x) => x.id !== session.shop?.id))
const to = ref<string | null>(null)
const q = ref('')
const products = ref<Product[]>([])
const lines = ref<{ p: Product; qty: number }[]>([])
const note = ref('')
const busy = ref(false)
let requestId = ''

async function start() {
  to.value = targets.value[0]?.id ?? null
  q.value = ''
  lines.value = []
  note.value = ''
  requestId = crypto.randomUUID()
  open.value = true
  try { products.value = (await listProducts(true)).filter((p) => p.stock > 0) } catch (e) { fail(e) }
}

const found = computed(() => {
  const s = q.value.trim()
  const taken = new Set(lines.value.map((l) => l.p.id))
  const list = products.value.filter((p) => !taken.has(p.id))
  return (s ? list.filter((p) => translitMatch(p.name, s) || (p.barcode ?? '').includes(s)) : list).slice(0, 30)
})
function add(p: Product) {
  lines.value.push({ p, qty: 1 })
  q.value = ''
  haptic('select')
}
const qtyOk = (l: { p: Product; qty: number }) => Number.isFinite(l.qty) && l.qty > 0 && l.qty <= l.p.stock + 1e-9
const totalCost = computed(() => lines.value.reduce((s, l) => s + (Number(l.qty) || 0) * l.p.cost_price, 0))
const ready = computed(() => !!to.value && lines.value.length > 0 && lines.value.every(qtyOk) && !busy.value)

async function submit() {
  if (!ready.value) return
  busy.value = true
  try {
    const r = await api<Transfer>('/api/transfers/create', {
      id: requestId, toShopId: to.value, note: note.value.trim() || null,
      items: lines.value.map((l) => ({ productId: l.p.id, qty: Number(l.qty) })),
    })
    haptic('success')
    notify(r.status === 'done' ? t('cloud.transfers.done', { shop: r.peer_name }) : t('cloud.transfers.pendingNote'), r.status === 'done' ? 'success' : 'info')
    open.value = false
    bumpData()
    await load()
  } catch (e) {
    // Tarmoq xatosi — o'sha id bilan qayta bosish xavfsiz; boshqa xato — yangi id (tuzatilgan so'rov).
    if (!(e instanceof RpcError && e.code === 'cloud.errors.network')) requestId = crypto.randomUUID()
    fail(e)
  } finally { busy.value = false }
}

function qtyText(items: Line[]) {
  const n = items.reduce((s, l) => s + l.qty, 0)
  return t('cloud.transfers.itemsLine', { lines: items.length, qty: Math.round(n * 1000) / 1000 })
}
</script>

<template>
  <div class="min-h-full">
    <header class="page-header">
      <h1 class="text-lg font-semibold">{{ $t('cloud.transfers.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ $t('cloud.transfers.subtitle') }}</p>
    </header>

    <div class="mx-auto max-w-xl space-y-3 p-4 pb-[calc(var(--tabbar-space)+1rem)]">
      <button type="button" class="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-sm font-semibold text-primary-foreground active:scale-[0.98] disabled:opacity-50" :disabled="!targets.length" @click="start">
        <Plus class="h-5 w-5" /> {{ $t('cloud.transfers.new') }}
      </button>

      <div v-if="loading" class="space-y-2">
        <div v-for="i in 3" :key="i" class="h-20 animate-pulse rounded-2xl bg-muted/60" />
      </div>
      <div v-else-if="!rows.length" class="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        <Truck class="mx-auto mb-2 h-8 w-8 opacity-50" />{{ $t('cloud.transfers.empty') }}
      </div>
      <button v-for="r in rows" :key="r.id + r.direction" type="button" class="block w-full rounded-2xl border bg-card p-3 text-left" @click="expanded = expanded === r.id ? null : r.id">
        <div class="flex items-center gap-3">
          <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl" :class="r.direction === 'out' ? 'bg-amber-500/10 text-amber-600' : 'bg-emerald-500/10 text-emerald-600'">
            <component :is="r.direction === 'out' ? ArrowRight : ArrowLeft" class="h-5 w-5" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="truncate font-semibold">{{ r.direction === 'out' ? $t('cloud.transfers.toShop', { shop: r.peer_name }) : $t('cloud.transfers.fromShop', { shop: r.peer_name }) }}</div>
            <div class="truncate text-xs text-muted-foreground">{{ formatDateTime(r.created_at) }} · {{ qtyText(r.items) }}</div>
          </div>
          <div class="shrink-0 text-right">
            <div class="text-sm font-semibold tabular-nums">{{ moneySum(r.total_cost) }}</div>
            <div class="mt-0.5 inline-flex items-center gap-1 text-[11px]" :class="r.status === 'done' ? 'text-emerald-600' : 'text-amber-600'">
              <component :is="r.status === 'done' ? CheckCircle2 : Clock" class="h-3 w-3" />{{ r.status === 'done' ? $t('cloud.transfers.statusDone') : $t('cloud.transfers.statusPending') }}
            </div>
          </div>
        </div>
        <div v-if="expanded === r.id" class="mt-3 space-y-1 border-t pt-2">
          <div v-for="l in r.items" :key="l.productId" class="flex justify-between gap-2 text-xs">
            <span class="min-w-0 flex-1 truncate">{{ l.name }}</span>
            <span class="shrink-0 tabular-nums text-muted-foreground">{{ l.qty }} {{ l.unit }} × {{ moneySum(l.cost) }}</span>
          </div>
          <div v-if="r.note" class="pt-1 text-xs italic text-muted-foreground">«{{ r.note }}»</div>
          <div v-if="r.user_name" class="text-[11px] text-muted-foreground">{{ r.user_name }}</div>
        </div>
      </button>
    </div>

    <GlassSheet :open="open" tall :title="$t('cloud.transfers.new')" @close="open = false">
      <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-2">
        <label class="block">
          <span class="mb-1 block text-xs font-medium text-muted-foreground">{{ $t('cloud.transfers.to') }}</span>
          <GlassSelect v-model="to" class="h-11 w-full rounded-xl border bg-background px-3 text-sm">
            <option v-for="x in targets" :key="x.id" :value="x.id">{{ x.name }}{{ x.catalogOf ? ` · ${$t('cloud.shops.branch')}` : '' }}</option>
          </GlassSelect>
        </label>

        <div v-for="(l, i) in lines" :key="l.p.id" class="flex items-center gap-2 rounded-xl border bg-card p-2.5">
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium">{{ l.p.name }}</div>
            <div class="text-[11px] text-muted-foreground tabular-nums">{{ $t('cloud.transfers.inStock', { qty: l.p.stock, unit: l.p.unit }) }}</div>
          </div>
          <input v-model.number="l.qty" type="number" min="0" step="any" inputmode="decimal" class="h-10 w-20 rounded-lg border bg-background px-2 text-right text-sm tabular-nums" :class="qtyOk(l) ? '' : 'border-rose-500'" />
          <span class="w-8 text-xs text-muted-foreground">{{ l.p.unit }}</span>
          <button type="button" class="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground" @click="lines.splice(i, 1)"><Trash2 class="h-4 w-4" /></button>
        </div>

        <div class="relative">
          <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input v-model="q" :placeholder="$t('cloud.transfers.search')" class="h-11 w-full rounded-xl border bg-background pr-3 pl-9 text-sm" />
        </div>
        <div class="space-y-1">
          <button v-for="p in found" :key="p.id" type="button" class="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm active:bg-muted" @click="add(p)">
            <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
            <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ p.stock }} {{ p.unit }}</span>
          </button>
          <div v-if="!found.length" class="py-3 text-center text-xs text-muted-foreground">{{ $t('cloud.transfers.noProducts') }}</div>
        </div>

        <input v-model="note" maxlength="300" :placeholder="$t('cloud.transfers.note')" class="h-11 w-full rounded-xl border bg-background px-3 text-sm" />
      </div>
      <div class="border-t px-4 pt-3">
        <div class="mb-2 flex justify-between text-sm"><span class="text-muted-foreground">{{ $t('cloud.transfers.totalCost') }}</span><b class="tabular-nums">{{ moneySum(totalCost) }}</b></div>
        <button type="button" class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50" :disabled="!ready" @click="submit">
          <Loader2 v-if="busy" class="h-4 w-4 animate-spin" /><Truck v-else class="h-4 w-4" /> {{ $t('cloud.transfers.submit') }}
        </button>
      </div>
    </GlassSheet>
  </div>
</template>
