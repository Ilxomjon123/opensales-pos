<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Clock, DoorOpen, Receipt, Coins } from 'lucide-vue-next'
import { db, type Shift } from '../lib/db'
import { moneySum, formatDateTime } from '../lib/format'

type Row = Shift & { sales_count: number; total_sales: number }
const shifts = ref<Row[]>([])
const statusFilter = ref<'all' | 'open' | 'closed'>('all')

onMounted(async () => {
  const d = await db()
  const rows = await d.select<Shift[]>('SELECT * FROM shifts ORDER BY id DESC LIMIT 200')
  const out: Row[] = []
  for (const s of rows) {
    const r = await d.select<{ c: number; t: number }[]>('SELECT COUNT(*) c, COALESCE(SUM(total),0) t FROM sales WHERE shift_id = ?', [s.id])
    out.push({ ...s, sales_count: r[0]?.c ?? 0, total_sales: r[0]?.t ?? 0 })
  }
  shifts.value = out
})

const visible = computed(() => {
  if (statusFilter.value === 'open') return shifts.value.filter((s) => s.status === 'open')
  if (statusFilter.value === 'closed') return shifts.value.filter((s) => s.status !== 'open')
  return shifts.value
})
const stats = computed(() => ({
  count: shifts.value.length,
  open: shifts.value.filter((s) => s.status === 'open').length,
  sales: shifts.value.reduce((s, x) => s + x.sales_count, 0),
  total: shifts.value.reduce((s, x) => s + x.total_sales, 0),
}))
const visTotal = computed(() => visible.value.reduce((s, x) => s + x.total_sales, 0))
function pickStatus(v: 'open' | 'closed') { statusFilter.value = statusFilter.value === v ? 'all' : v }
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="border-b px-6 py-4">
      <h1 class="text-lg font-semibold">Smenalar</h1>
      <p class="text-sm text-muted-foreground">{{ stats.count }} ta · {{ stats.open }} ochiq</p>
    </header>

    <!-- Stat kartalar -->
    <div class="grid grid-cols-2 gap-3 border-b px-6 py-4 lg:grid-cols-4">
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Clock class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Smenalar</div><div class="text-lg font-bold tabular-nums">{{ stats.count }}</div></div>
      </div>
      <button @click="pickStatus('open')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="statusFilter === 'open' ? 'border-emerald-500 ring-1 ring-emerald-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><DoorOpen class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Ochiq</div><div class="text-lg font-bold tabular-nums">{{ stats.open }}</div></div>
      </button>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600"><Receipt class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Sotuvlar</div><div class="text-lg font-bold tabular-nums">{{ stats.sales }}</div></div>
      </div>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><Coins class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Jami summa</div><div class="text-lg font-bold tabular-nums">{{ moneySum(stats.total) }}</div></div>
      </div>
    </div>

    <!-- Filtrlar -->
    <div class="flex flex-wrap items-center gap-2 border-b px-6 py-3">
      <select v-model="statusFilter" class="h-9 rounded-lg border bg-card px-3 text-sm">
        <option value="all">Barcha smenalar</option>
        <option value="open">Ochiq</option>
        <option value="closed">Yopiq</option>
      </select>
    </div>

    <div class="flex-1 overflow-auto pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-0">
      <table class="w-full text-sm">
        <thead class="sticky top-0 z-10 border-b bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr><th class="px-4 py-3">#</th><th class="px-4 py-3">Ochilgan</th><th class="px-4 py-3">Yopilgan</th><th class="px-4 py-3 text-right">Sotuvlar</th><th class="px-4 py-3 text-right">Summa</th><th class="px-4 py-3">Holat</th></tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="s in visible" :key="s.id" class="hover:bg-muted/40">
            <td class="px-4 py-3 font-medium">{{ s.id }}</td>
            <td class="px-4 py-3 text-xs">{{ formatDateTime(s.opened_at) }}</td>
            <td class="px-4 py-3 text-xs">{{ formatDateTime(s.closed_at) }}</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ s.sales_count }}</td>
            <td class="px-4 py-3 text-right font-semibold tabular-nums">{{ moneySum(s.total_sales) }}</td>
            <td class="px-4 py-3"><span class="rounded-full px-2 py-0.5 text-xs" :class="s.status === 'open' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-slate-500/15 text-slate-600'">{{ s.status === 'open' ? 'Ochiq' : 'Yopiq' }}</span></td>
          </tr>
          <tr v-if="visible.length === 0"><td colspan="6" class="px-4 py-16 text-center text-muted-foreground"><Clock class="mx-auto mb-2 h-8 w-8 opacity-40" /> Smena topilmadi</td></tr>
        </tbody>
        <tfoot v-if="visible.length" class="sticky bottom-0 border-t-2 bg-card text-sm font-semibold">
          <tr>
            <td class="px-4 py-3" colspan="4">Jami: {{ visible.length }} ta</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(visTotal) }}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>
</template>
