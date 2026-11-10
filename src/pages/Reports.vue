<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { TrendingUp, Receipt, Coins, Boxes, Calendar, Wallet, CircleDollarSign } from 'lucide-vue-next'
import { expensesTotal } from '../lib/db'
import { reportSummary, firstSaleDate } from '../lib/reports'
import { moneySum } from '../lib/format'

function iso(d: Date) { return d.toISOString().slice(0, 10) }
const now = new Date()
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

const dateFrom = ref(iso(monthStart))
const dateTo = ref(iso(now))

// gross — davrdagi sotuvlar; total/cash/card/profit — vozvratlar ayirilgandan keyin (sof).
const period = ref({ count: 0, gross: 0, total: 0, cash: 0, card: 0, debt: 0, returns: 0, profit: 0, expenses: 0, net: 0 })
const topProducts = ref<{ name: string; qty: number; total: number }[]>([])
const lowStock = ref<{ name: string; stock: number; unit: string }[]>([])

async function preset(kind: 'today' | 'week' | 'month' | 'quarter' | 'year' | 'all') {
  const t = new Date()
  if (kind === 'today') { dateFrom.value = iso(t); dateTo.value = iso(t) }
  else if (kind === 'week') { const w = new Date(); w.setDate(w.getDate() - 6); dateFrom.value = iso(w); dateTo.value = iso(t) }
  else if (kind === 'month') { dateFrom.value = iso(new Date(t.getFullYear(), t.getMonth(), 1)); dateTo.value = iso(t) }
  else if (kind === 'quarter') { dateFrom.value = iso(new Date(t.getFullYear(), t.getMonth() - 2, 1)); dateTo.value = iso(t) }
  else if (kind === 'year') { dateFrom.value = iso(new Date(t.getFullYear(), 0, 1)); dateTo.value = iso(t) }
  else {
    // Ilk sotuv kunidan bugungacha
    dateFrom.value = (await firstSaleDate()) ?? iso(t)
    dateTo.value = iso(t)
  }
}

async function load() {
  const from = dateFrom.value, to = dateTo.value
  const r = await reportSummary(from, to)
  // Savdo natijalarini darhol o'rnatamiz — xarajat jadvali bo'lmasa ham hisobot ko'rinadi.
  period.value = { ...r.period, expenses: 0, net: r.period.profit }
  try {
    const exp = await expensesTotal(from, to)
    period.value = { ...period.value, expenses: exp, net: r.period.profit - exp }
  } catch (e) { console.error('expensesTotal:', e) /* xarajat o'qilmadi — 0, lekin log qoldiramiz */ }
  topProducts.value = r.topProducts
  lowStock.value = r.lowStock
}
onMounted(load)
watch([dateFrom, dateTo], load)
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="page-header">
      <h1 class="text-lg font-semibold">{{ $t('reports.title') }}</h1>
      <p class="truncate text-sm text-muted-foreground">{{ $t('reports.subtitle') }}</p>
    </header>

    <!-- Sana filtri -->
    <div class="space-y-2 border-b px-4 py-3 sm:flex sm:flex-wrap sm:items-center sm:gap-2 sm:space-y-0 sm:px-6">
      <div class="flex items-center gap-2">
        <Calendar class="h-4 w-4 shrink-0 text-muted-foreground" />
        <input v-model="dateFrom" type="date" class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm sm:flex-none" />
        <span class="text-muted-foreground">—</span>
        <input v-model="dateTo" type="date" class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm sm:flex-none" />
      </div>
      <div class="grid grid-cols-3 gap-1.5 sm:ml-1 sm:flex">
        <button @click="preset('today')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">{{ $t('reports.today') }}</button>
        <button @click="preset('week')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">{{ $t('reports.week7') }}</button>
        <button @click="preset('month')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">{{ $t('reports.month') }}</button>
        <button @click="preset('quarter')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">{{ $t('reports.months3') }}</button>
        <button @click="preset('year')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">{{ $t('reports.year') }}</button>
        <button @click="preset('all')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">{{ $t('common.all') }}</button>
      </div>
    </div>

    <div class="flex-1 space-y-4 overflow-auto p-4 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] sm:p-6 lg:pb-6">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Receipt class="h-4 w-4" /> {{ $t('reports.periodSales') }}</div>
          <div class="mt-2 text-2xl font-bold">{{ period.count }}</div>
          <div class="text-sm text-muted-foreground">{{ moneySum(period.gross) }}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Coins class="h-4 w-4" /> {{ $t('reports.cashCard') }}</div>
          <div class="mt-2 text-lg font-bold tabular-nums">{{ moneySum(period.cash) }}</div>
          <div class="text-sm text-muted-foreground">{{ $t('reports.cardAmount', { amount: moneySum(period.card) }) }}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><TrendingUp class="h-4 w-4" /> {{ $t('reports.turnover') }}</div>
          <div class="mt-2 text-lg font-bold tabular-nums">{{ moneySum(period.total) }}</div>
          <div class="text-sm text-muted-foreground">{{ $t('reports.salesCount', { count: period.count }) }}</div>
          <div v-if="period.returns > 0" class="text-xs tabular-nums text-amber-600">{{ $t('reports.returnsLine', { amount: moneySum(period.returns) }) }}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Boxes class="h-4 w-4" /> {{ $t('reports.debt') }}</div>
          <div class="mt-2 text-lg font-bold tabular-nums text-rose-600">{{ moneySum(period.debt) }}</div>
        </div>
      </div>

      <!-- Foyda xulosasi: yalpi foyda − xarajat = sof foyda -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><TrendingUp class="h-4 w-4" /> {{ $t('reports.grossProfit') }}</div>
          <div class="mt-2 text-xl font-bold tabular-nums text-emerald-600">{{ moneySum(period.profit) }}</div>
          <div class="text-xs text-muted-foreground">{{ $t('reports.grossProfitHint') }}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Wallet class="h-4 w-4" /> {{ $t('reports.expenses') }}</div>
          <div class="mt-2 text-xl font-bold tabular-nums text-rose-600">− {{ moneySum(period.expenses) }}</div>
          <div class="text-xs text-muted-foreground">{{ $t('reports.expensesHint') }}</div>
        </div>
        <div class="rounded-xl border-2 p-4" :class="period.net >= 0 ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-rose-500/40 bg-rose-500/5'">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><CircleDollarSign class="h-4 w-4" /> {{ $t('reports.netProfit') }}</div>
          <div class="mt-2 text-2xl font-bold tabular-nums" :class="period.net >= 0 ? 'text-emerald-600' : 'text-rose-600'">{{ period.net < 0 ? '− ' + moneySum(-period.net) : moneySum(period.net) }}</div>
          <div class="text-xs text-muted-foreground">{{ $t('reports.netProfitHint') }}</div>
        </div>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="rounded-xl border bg-card">
          <div class="border-b px-4 py-3 text-sm font-semibold">{{ $t('reports.topSelling') }}</div>
          <table class="w-full text-sm">
            <tbody class="divide-y">
              <tr v-for="p in topProducts" :key="p.name"><td class="px-4 py-2">{{ p.name }}</td><td class="px-4 py-2 text-right text-muted-foreground tabular-nums">{{ p.qty }}</td><td class="px-4 py-2 text-right font-medium tabular-nums">{{ moneySum(p.total) }}</td></tr>
              <tr v-if="topProducts.length === 0"><td class="px-4 py-6 text-center text-muted-foreground">{{ $t('reports.noData') }}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="rounded-xl border bg-card">
          <div class="border-b px-4 py-3 text-sm font-semibold">{{ $t('reports.lowStock') }}</div>
          <table class="w-full text-sm">
            <tbody class="divide-y">
              <tr v-for="p in lowStock" :key="p.name"><td class="px-4 py-2">{{ p.name }}</td><td class="px-4 py-2 text-right tabular-nums" :class="p.stock <= 0 ? 'text-rose-500' : 'text-amber-600'">{{ p.stock }} {{ p.unit }}</td></tr>
              <tr v-if="lowStock.length === 0"><td class="px-4 py-6 text-center text-muted-foreground">{{ $t('reports.allSufficient') }}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
