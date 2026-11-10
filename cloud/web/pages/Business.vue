<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Store, GitBranch, ChevronRight, AlertTriangle } from 'lucide-vue-next'
import { api, RpcError } from '../rpc'
import { session, switchShop } from '../session'
import { haptic } from '../telegram'
import { moneySum } from '../../../src/lib/format'
import { notify } from '../../../src/lib/notify'

// Umumiy hisobot (2026-11-09): biznesning user EGA bo'lgan barcha do'konlari — davr savdosi, foyda, xarajat
// (Hisobot sahifasi bilan bir xil formula, UTC kun) va hozirgi holat: mijozlar qarzi, ombor qiymati.
type Sum = Record<'count' | 'total' | 'cash' | 'card' | 'debt' | 'returns' | 'profit' | 'expenses' | 'net' | 'receivable' | 'debtors' | 'stockCost' | 'stockRetail' | 'products', number>
type ShopRow = { id: string; name: string; branch: boolean; data?: Sum; error?: string }
type Report = { from: string; to: string; shops: ShopRow[]; total: Sum }

const { t } = useI18n()
const period = ref<'today' | 'week' | 'month' | 'lastMonth'>('today')
const report = ref<Report | null>(null)
const loading = ref(true)

const iso = (d: Date) => d.toISOString().slice(0, 10)
function range(p: typeof period.value): [string, string] {
  const now = new Date()
  const y = now.getUTCFullYear(), m = now.getUTCMonth()
  if (p === 'week') return [iso(new Date(now.getTime() - 6 * 86400_000)), iso(now)]
  if (p === 'month') return [iso(new Date(Date.UTC(y, m, 1))), iso(now)]
  if (p === 'lastMonth') return [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))]
  return [iso(now), iso(now)]
}

async function load() {
  loading.value = true
  const [from, to] = range(period.value)
  try { report.value = await api<Report>('/api/group/report', { from, to }) }
  catch (e) { notify(e instanceof RpcError ? t(e.code, e.params) : String(e), 'error') }
  finally { loading.value = false }
}
onMounted(load)
watch(period, () => { haptic('select'); void load() })

const periods = computed(() => (['today', 'week', 'month', 'lastMonth'] as const).map((p) => ({ p, label: t(`cloud.business.period.${p}`) })))
const tiles = computed(() => {
  const s = report.value?.total
  if (!s) return []
  return [
    { k: 'sales', v: s.total, sub: t('cloud.business.receipts', { n: s.count }) },
    { k: 'profit', v: s.profit, tone: s.profit >= 0 ? 'pos' : 'neg' },
    { k: 'expenses', v: s.expenses },
    { k: 'net', v: s.net, tone: s.net >= 0 ? 'pos' : 'neg' },
    { k: 'receivable', v: s.receivable, sub: t('cloud.business.debtors', { n: s.debtors }) },
    { k: 'stock', v: s.stockCost, sub: t('cloud.business.retail', { sum: moneySum(s.stockRetail) }) },
  ]
})

async function open(r: ShopRow) {
  if (r.id === session.shop?.id) return
  haptic('select')
  try { await switchShop(r.id) } catch (e) { notify(t((e as Error).message), 'error') }
}
</script>

<template>
  <div class="min-h-full">
    <header class="page-header">
      <h1 class="text-lg font-semibold">{{ $t('cloud.business.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ $t('cloud.business.subtitle') }}</p>
    </header>

    <div class="mx-auto max-w-xl space-y-3 p-4 pb-[calc(var(--tabbar-space)+1rem)]">
      <div class="flex gap-2 overflow-x-auto">
        <button v-for="x in periods" :key="x.p" type="button" class="h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium" :class="period === x.p ? 'border-primary bg-primary text-primary-foreground' : 'bg-card'" @click="period = x.p">{{ x.label }}</button>
      </div>

      <div v-if="loading && !report" class="grid grid-cols-2 gap-2">
        <div v-for="i in 6" :key="i" class="h-20 animate-pulse rounded-2xl bg-muted/60" />
      </div>
      <template v-else-if="report">
        <div class="grid grid-cols-2 gap-2" :class="{ 'opacity-60': loading }">
          <div v-for="x in tiles" :key="x.k" class="rounded-2xl border bg-card p-3">
            <div class="text-xs text-muted-foreground">{{ $t(`cloud.business.tile.${x.k}`) }}</div>
            <div class="mt-0.5 text-base font-bold tabular-nums" :class="x.tone === 'neg' ? 'text-rose-600' : x.tone === 'pos' ? 'text-emerald-600' : ''">{{ moneySum(x.v) }}</div>
            <div v-if="x.sub" class="truncate text-[11px] text-muted-foreground">{{ x.sub }}</div>
          </div>
        </div>

        <h2 class="px-1 pt-2 text-sm font-semibold text-muted-foreground">{{ $t('cloud.business.byShop') }}</h2>
        <button v-for="r in report.shops" :key="r.id" type="button" class="block w-full rounded-2xl border bg-card p-3 text-left" :class="{ 'border-primary': r.id === session.shop?.id }" @click="open(r)">
          <div class="mb-2 flex items-center gap-2">
            <component :is="r.branch ? GitBranch : Store" class="h-4 w-4 shrink-0 text-primary" />
            <span class="min-w-0 flex-1 truncate font-semibold">{{ r.name }}</span>
            <span v-if="r.id === session.shop?.id" class="text-[11px] text-primary">{{ $t('cloud.business.current') }}</span>
            <ChevronRight v-else class="h-4 w-4 text-muted-foreground" />
          </div>
          <div v-if="r.data" class="grid grid-cols-3 gap-2 text-xs">
            <div><div class="text-muted-foreground">{{ $t('cloud.business.tile.sales') }}</div><div class="font-semibold tabular-nums">{{ moneySum(r.data.total) }}</div></div>
            <div><div class="text-muted-foreground">{{ $t('cloud.business.tile.profit') }}</div><div class="font-semibold tabular-nums" :class="r.data.profit < 0 ? 'text-rose-600' : ''">{{ moneySum(r.data.profit) }}</div></div>
            <div><div class="text-muted-foreground">{{ $t('cloud.business.tile.stock') }}</div><div class="font-semibold tabular-nums">{{ moneySum(r.data.stockCost) }}</div></div>
            <div><div class="text-muted-foreground">{{ $t('cloud.business.receiptsShort') }}</div><div class="font-semibold tabular-nums">{{ r.data.count }}</div></div>
            <div><div class="text-muted-foreground">{{ $t('cloud.business.tile.expenses') }}</div><div class="font-semibold tabular-nums">{{ moneySum(r.data.expenses) }}</div></div>
            <div><div class="text-muted-foreground">{{ $t('cloud.business.tile.receivable') }}</div><div class="font-semibold tabular-nums">{{ moneySum(r.data.receivable) }}</div></div>
          </div>
          <div v-else class="flex items-center gap-2 text-xs text-rose-600"><AlertTriangle class="h-4 w-4" />{{ $t(r.error ?? 'cloud.errors.internal') }}</div>
        </button>
      </template>
    </div>
  </div>
</template>
