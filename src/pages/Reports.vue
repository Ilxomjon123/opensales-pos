<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { TrendingUp, Receipt, Coins, Boxes } from 'lucide-vue-next'
import { db } from '../lib/db'
import { moneySum } from '../lib/format'

const today = ref({ count: 0, total: 0, cash: 0, card: 0, debt: 0 })
const all = ref({ count: 0, total: 0, profit: 0 })
const topProducts = ref<{ name: string; qty: number; total: number }[]>([])
const lowStock = ref<{ name: string; stock: number; unit: string }[]>([])

onMounted(async () => {
  const d = await db()
  const t = await d.select<any[]>(
    `SELECT COUNT(*) count, COALESCE(SUM(total),0) total, COALESCE(SUM(paid_cash),0) cash, COALESCE(SUM(paid_card),0) card, COALESCE(SUM(debt_amount),0) debt
     FROM sales WHERE date(created_at) = date('now','localtime')`,
  )
  today.value = t[0]
  const a = await d.select<any[]>('SELECT COUNT(*) count, COALESCE(SUM(total),0) total FROM sales')
  const p = await d.select<any[]>(
    `SELECT COALESCE(SUM((si.price - p.cost_price) * si.qty),0) profit
     FROM sale_items si JOIN products p ON p.id = si.product_id`,
  )
  all.value = { count: a[0].count, total: a[0].total, profit: p[0]?.profit ?? 0 }
  topProducts.value = await d.select(
    `SELECT product_name name, SUM(qty) qty, SUM(subtotal) total FROM sale_items GROUP BY product_name ORDER BY total DESC LIMIT 8`,
  )
  lowStock.value = await d.select(
    `SELECT name, stock, unit FROM products WHERE is_active = 1 AND stock <= 10 ORDER BY stock LIMIT 10`,
  )
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="border-b px-6 py-4">
      <h1 class="text-lg font-semibold">Hisobotlar</h1>
      <p class="text-sm text-muted-foreground">Savdo va inventar tahlili</p>
    </header>
    <div class="flex-1 space-y-4 overflow-auto p-6">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Receipt class="h-4 w-4" /> Bugun sotuvlar</div>
          <div class="mt-2 text-2xl font-bold">{{ today.count }}</div>
          <div class="text-sm text-muted-foreground">{{ moneySum(today.total) }}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Coins class="h-4 w-4" /> Bugun naqd / karta</div>
          <div class="mt-2 text-lg font-bold tabular-nums">{{ moneySum(today.cash) }}</div>
          <div class="text-sm text-muted-foreground">karta {{ moneySum(today.card) }}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><TrendingUp class="h-4 w-4" /> Umumiy aylanma</div>
          <div class="mt-2 text-lg font-bold tabular-nums">{{ moneySum(all.total) }}</div>
          <div class="text-sm text-emerald-600">foyda ~ {{ moneySum(all.profit) }}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Boxes class="h-4 w-4" /> Bugun qarz</div>
          <div class="mt-2 text-lg font-bold tabular-nums text-rose-600">{{ moneySum(today.debt) }}</div>
        </div>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="rounded-xl border bg-card">
          <div class="border-b px-4 py-3 text-sm font-semibold">Eng ko'p sotilgan</div>
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
