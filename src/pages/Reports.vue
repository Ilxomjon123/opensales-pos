<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { TrendingUp, Receipt, Coins, Boxes, Calendar, Wallet, PiggyBank } from 'lucide-vue-next'
import { db, expensesTotal } from '../lib/db'
import { moneySum } from '../lib/format'

function iso(d: Date) { return d.toISOString().slice(0, 10) }
const now = new Date()
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

const dateFrom = ref(iso(monthStart))
const dateTo = ref(iso(now))

const period = ref({ count: 0, total: 0, cash: 0, card: 0, debt: 0, profit: 0, expenses: 0, net: 0 })
const topProducts = ref<{ name: string; qty: number; total: number }[]>([])
const lowStock = ref<{ name: string; stock: number; unit: string }[]>([])

async function preset(kind: 'today' | 'week' | 'month' | 'all') {
  const t = new Date()
  if (kind === 'today') { dateFrom.value = iso(t); dateTo.value = iso(t) }
  else if (kind === 'week') { const w = new Date(); w.setDate(w.getDate() - 6); dateFrom.value = iso(w); dateTo.value = iso(t) }
  else if (kind === 'month') { dateFrom.value = iso(new Date(t.getFullYear(), t.getMonth(), 1)); dateTo.value = iso(t) }
  else {
    // Ilk sotuv kunidan bugungacha
    const d = await db()
    const r = await d.select<{ first: string | null }[]>("SELECT date(MIN(created_at)) first FROM sales")
    dateFrom.value = r[0]?.first ?? iso(t)
    dateTo.value = iso(t)
  }
}

async function load() {
  const d = await db()
  const from = dateFrom.value, to = dateTo.value
  const t = await d.select<any[]>(
    `SELECT COUNT(*) count, COALESCE(SUM(total),0) total, COALESCE(SUM(paid_cash),0) cash,
            COALESCE(SUM(paid_card),0) card, COALESCE(SUM(debt_amount),0) debt
     FROM sales WHERE date(created_at) BETWEEN ? AND ?`, [from, to],
  )
  const p = await d.select<any[]>(
    // Tannarx sotuvda muzlatiladi (si.cost_price). Eski sotuvlarda u 0 — o'shanda joriy
    // mahsulot tannarxiga qaytamiz (eski hisobotlar buzilmasin).
    `SELECT COALESCE(SUM((si.price - COALESCE(NULLIF(si.cost_price,0), pr.cost_price, 0)) * si.qty),0) profit
     FROM sale_items si LEFT JOIN products pr ON pr.id = si.product_id
     JOIN sales s ON s.id = si.sale_id
     WHERE date(s.created_at) BETWEEN ? AND ?`, [from, to],
  )
  const grossProfit = p[0]?.profit ?? 0
  // Savdo natijalarini darhol o'rnatamiz — xarajat jadvali bo'lmasa ham hisobot ko'rinadi.
  period.value = { ...t[0], profit: grossProfit, expenses: 0, net: grossProfit }
  try {
    const exp = await expensesTotal(from, to)
    period.value = { ...period.value, expenses: exp, net: grossProfit - exp }
  } catch (e) { console.error('expensesTotal:', e) /* xarajat o'qilmadi — 0, lekin log qoldiramiz */ }
  topProducts.value = await d.select(
    `SELECT si.product_name name, SUM(si.qty) qty, SUM(si.subtotal) total
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE date(s.created_at) BETWEEN ? AND ?
     GROUP BY si.product_name ORDER BY total DESC LIMIT 8`, [from, to],
  )
  lowStock.value = await d.select(
    `SELECT name, stock, unit FROM products WHERE is_active = 1 AND stock <= 10 ORDER BY stock LIMIT 10`,
  )
}
onMounted(load)
watch([dateFrom, dateTo], load)
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="page-header">
      <h1 class="text-lg font-semibold">Hisobotlar</h1>
      <p class="truncate text-sm text-muted-foreground">Savdo va inventar tahlili</p>
    </header>

    <!-- Sana filtri -->
    <div class="space-y-2 border-b px-4 py-3 sm:flex sm:flex-wrap sm:items-center sm:gap-2 sm:space-y-0 sm:px-6">
      <div class="flex items-center gap-2">
        <Calendar class="h-4 w-4 shrink-0 text-muted-foreground" />
        <input v-model="dateFrom" type="date" class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm sm:flex-none" />
        <span class="text-muted-foreground">—</span>
        <input v-model="dateTo" type="date" class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm sm:flex-none" />
      </div>
      <div class="grid grid-cols-4 gap-1.5 sm:ml-1 sm:flex">
        <button @click="preset('today')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">Bugun</button>
        <button @click="preset('week')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">7 kun</button>
        <button @click="preset('month')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">Oy</button>
        <button @click="preset('all')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">Hammasi</button>
      </div>
    </div>

    <div class="flex-1 space-y-4 overflow-auto p-4 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] sm:p-6 lg:pb-6">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Receipt class="h-4 w-4" /> Davr sotuvlari</div>
          <div class="mt-2 text-2xl font-bold">{{ period.count }}</div>
          <div class="text-sm text-muted-foreground">{{ moneySum(period.total) }}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Coins class="h-4 w-4" /> Naqd / karta</div>
          <div class="mt-2 text-lg font-bold tabular-nums">{{ moneySum(period.cash) }}</div>
          <div class="text-sm text-muted-foreground">karta {{ moneySum(period.card) }}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><TrendingUp class="h-4 w-4" /> Aylanma</div>
          <div class="mt-2 text-lg font-bold tabular-nums">{{ moneySum(period.total) }}</div>
          <div class="text-sm text-muted-foreground">{{ period.count }} ta sotuv</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Boxes class="h-4 w-4" /> Qarz</div>
          <div class="mt-2 text-lg font-bold tabular-nums text-rose-600">{{ moneySum(period.debt) }}</div>
        </div>
      </div>

      <!-- Foyda xulosasi: yalpi foyda − xarajat = sof foyda -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><TrendingUp class="h-4 w-4" /> Yalpi foyda</div>
          <div class="mt-2 text-xl font-bold tabular-nums text-emerald-600">{{ moneySum(period.profit) }}</div>
          <div class="text-xs text-muted-foreground">savdo foydasi (tannarxdan keyin)</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Wallet class="h-4 w-4" /> Xarajatlar</div>
          <div class="mt-2 text-xl font-bold tabular-nums text-rose-600">− {{ moneySum(period.expenses) }}</div>
          <div class="text-xs text-muted-foreground">davr ichidagi jami xarajat</div>
        </div>
        <div class="rounded-xl border-2 p-4" :class="period.net >= 0 ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-rose-500/40 bg-rose-500/5'">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><PiggyBank class="h-4 w-4" /> Sof foyda</div>
          <div class="mt-2 text-2xl font-bold tabular-nums" :class="period.net >= 0 ? 'text-emerald-600' : 'text-rose-600'">{{ period.net < 0 ? '− ' + moneySum(-period.net) : moneySum(period.net) }}</div>
          <div class="text-xs text-muted-foreground">yalpi foyda − xarajat</div>
        </div>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="rounded-xl border bg-card">
          <div class="border-b px-4 py-3 text-sm font-semibold">Eng ko'p sotilgan (davr)</div>
          <table class="w-full text-sm">
            <tbody class="divide-y">
              <tr v-for="p in topProducts" :key="p.name"><td class="px-4 py-2">{{ p.name }}</td><td class="px-4 py-2 text-right text-muted-foreground tabular-nums">{{ p.qty }}</td><td class="px-4 py-2 text-right font-medium tabular-nums">{{ moneySum(p.total) }}</td></tr>
              <tr v-if="topProducts.length === 0"><td class="px-4 py-6 text-center text-muted-foreground">Ma'lumot yo'q</td></tr>
            </tbody>
          </table>
        </div>
        <div class="rounded-xl border bg-card">
          <div class="border-b px-4 py-3 text-sm font-semibold">Kam qolgan mahsulotlar</div>
          <table class="w-full text-sm">
            <tbody class="divide-y">
              <tr v-for="p in lowStock" :key="p.name"><td class="px-4 py-2">{{ p.name }}</td><td class="px-4 py-2 text-right tabular-nums" :class="p.stock <= 0 ? 'text-rose-500' : 'text-amber-600'">{{ p.stock }} {{ p.unit }}</td></tr>
              <tr v-if="lowStock.length === 0"><td class="px-4 py-6 text-center text-muted-foreground">Hammasi yetarli</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
