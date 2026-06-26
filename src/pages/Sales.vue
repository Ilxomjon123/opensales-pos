<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { Receipt, ChevronDown, Search, Printer, Coins, Wallet, HandCoins } from 'lucide-vue-next'
import { listSales, listProducts, listCustomers, type SaleItem, type Product, type Customer } from '../lib/db'
import { moneySum, formatDateTime, translitMatch } from '../lib/format'
import SearchableSelect from '../components/SearchableSelect.vue'
import { printReceipt } from '../lib/print'

function printSale(s: Row) {
  printReceipt({
    receipt_number: s.receipt_number,
    created_at: s.created_at,
    customer: s.customer_name ?? '—',
    items: s.items.map((i) => ({ name: i.product_name, qty: i.qty, unit: i.unit, price: i.price, subtotal: i.subtotal })),
    discount: s.discount,
    total: s.total,
    paid_cash: s.paid_cash,
    paid_card: s.paid_card,
    change: Math.max(0, s.paid_amount - s.total),
    debt: s.debt_amount,
  })
}

type Row = Awaited<ReturnType<typeof listSales>>[number]
const sales = ref<Row[]>([])
const products = ref<Product[]>([])
const customers = ref<Customer[]>([])
const expanded = ref<Set<number>>(new Set())
const search = ref('')
const status = ref('')
const productId = ref<number | null>(null)
const customerId = ref<number | null>(null)
const dateFrom = ref('')
const dateTo = ref('')

const statusLabels: Record<string, string> = { paid: "To'langan", partial: 'Qisman', debt: 'Qarz', unpaid: "To'lanmagan" }
const statusStyles: Record<string, string> = {
  paid: 'bg-emerald-500/15 text-emerald-600', partial: 'bg-amber-500/15 text-amber-600',
  debt: 'bg-rose-500/15 text-rose-600', unpaid: 'bg-slate-500/15 text-slate-600',
}

async function load() {
  sales.value = await listSales({
    paymentStatus: status.value || undefined,
    productId: productId.value || undefined,
    customerId: customerId.value || undefined,
    dateFrom: dateFrom.value || undefined,
    dateTo: dateTo.value || undefined,
  })
}
onMounted(async () => { [products.value, customers.value] = await Promise.all([listProducts(false), listCustomers()]); await load() })
watch([status, productId, customerId, dateFrom, dateTo], load)

const visible = computed(() =>
  search.value.trim() ? sales.value.filter((s) => translitMatch(s.receipt_number, search.value)) : sales.value,
)
const totals = computed(() => ({
  count: visible.value.length,
  total: visible.value.reduce((s, x) => s + x.total, 0),
  paid: visible.value.reduce((s, x) => s + x.paid_amount, 0),
  debt: visible.value.reduce((s, x) => s + x.debt_amount, 0),
}))
const productItems = computed(() => products.value.map((p) => ({ value: p.id, label: p.name })))
const customerItems = computed(() => customers.value.map((c) => ({ value: c.id, label: c.phone ? `${c.name} · ${c.phone}` : c.name })))
function pickStatus(v: string) { status.value = status.value === v ? '' : v }
function toggle(id: number) { const n = new Set(expanded.value); n.has(id) ? n.delete(id) : n.add(id); expanded.value = n }
function itemQtyUnit(i: SaleItem) { return `${i.qty} ${i.unit}` }
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="border-b px-6 py-4">
      <h1 class="text-lg font-semibold">Sotuvlar</h1>
      <p class="text-sm text-muted-foreground">{{ totals.count }} ta · jami {{ moneySum(totals.total) }} · qarz {{ moneySum(totals.debt) }}</p>
    </header>

    <!-- Stat kartalar -->
    <div class="grid grid-cols-2 gap-3 border-b px-6 py-4 lg:grid-cols-4">
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Receipt class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Sotuvlar</div><div class="text-lg font-bold tabular-nums">{{ totals.count }}</div></div>
      </div>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600"><Coins class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Jami summa</div><div class="text-lg font-bold tabular-nums">{{ moneySum(totals.total) }}</div></div>
      </div>
      <button @click="pickStatus('paid')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="status === 'paid' ? 'border-emerald-500 ring-1 ring-emerald-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><Wallet class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">To'langan</div><div class="text-lg font-bold tabular-nums text-emerald-600">{{ moneySum(totals.paid) }}</div></div>
      </button>
      <button @click="pickStatus('debt')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="status === 'debt' ? 'border-rose-500 ring-1 ring-rose-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600"><HandCoins class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Qarz</div><div class="text-lg font-bold tabular-nums text-rose-600">{{ moneySum(totals.debt) }}</div></div>
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-2 border-b px-6 py-3">
      <div class="relative min-w-48 flex-1">
        <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input v-model="search" placeholder="Chek raqami…" class="h-9 w-full rounded-md border bg-background pl-9 pr-2 text-sm" />
      </div>
      <div class="w-52"><SearchableSelect v-model="customerId" :items="customerItems" placeholder="Barcha mijozlar" search-placeholder="Mijoz…" clearable /></div>
      <div class="w-52"><SearchableSelect v-model="productId" :items="productItems" placeholder="Barcha tovarlar" search-placeholder="Tovar nomi…" clearable /></div>
      <input v-model="dateFrom" type="date" class="h-9 rounded-md border bg-background px-2 text-sm" />
      <span class="text-muted-foreground">—</span>
      <input v-model="dateTo" type="date" class="h-9 rounded-md border bg-background px-2 text-sm" />
      <select v-model="status" class="h-9 rounded-md border bg-card px-3 text-sm">
        <option value="">Barcha holatlar</option>
        <option value="paid">To'langan</option>
        <option value="partial">Qisman</option>
        <option value="debt">Qarz</option>
      </select>
    </div>

    <div class="flex-1 overflow-auto pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-0">
      <table class="w-full text-sm">
        <thead class="sticky top-0 z-10 border-b bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr>
            <th class="w-8 px-2 py-3"></th>
            <th class="px-4 py-3">Chek</th><th class="px-4 py-3">Mijoz</th><th class="px-4 py-3">Vaqt</th>
            <th class="px-4 py-3 text-right">Summa</th><th class="px-4 py-3 text-right">To'langan</th>
            <th class="px-4 py-3 text-right">Qarz</th><th class="px-4 py-3">Holat</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <template v-for="s in visible" :key="s.id">
            <tr class="cursor-pointer hover:bg-muted/40" @click="toggle(s.id)">
              <td class="px-2 py-3 text-center text-muted-foreground"><ChevronDown class="inline h-4 w-4 transition-transform" :class="expanded.has(s.id) ? 'rotate-180' : ''" /></td>
              <td class="px-4 py-3"><span class="inline-flex items-center gap-1 font-medium text-primary"><Receipt class="h-3 w-3" />{{ s.receipt_number }}</span></td>
              <td class="px-4 py-3">{{ s.customer_name ?? '—' }}</td>
              <td class="px-4 py-3 text-xs">{{ formatDateTime(s.created_at) }}</td>
              <td class="px-4 py-3 text-right font-semibold">{{ moneySum(s.total) }}</td>
              <td class="px-4 py-3 text-right text-emerald-600">{{ moneySum(s.paid_amount) }}</td>
              <td class="px-4 py-3 text-right" :class="s.debt_amount > 0 ? 'text-rose-500' : ''">{{ s.debt_amount > 0 ? moneySum(s.debt_amount) : '—' }}</td>
              <td class="px-4 py-3"><span class="inline-flex rounded-full px-2 py-0.5 text-xs" :class="statusStyles[s.payment_status]">{{ statusLabels[s.payment_status] }}</span></td>
            </tr>
            <tr v-if="expanded.has(s.id)" class="bg-muted/20">
              <td></td>
              <td colspan="7" class="px-4 py-3">
                <table class="w-full text-xs">
                  <thead class="text-left text-muted-foreground"><tr><th class="py-1">Tovar</th><th class="py-1 text-right">Miqdor</th><th class="py-1 text-right">Narx</th><th class="py-1 text-right">Summa</th></tr></thead>
                  <tbody>
                    <tr v-for="i in s.items" :key="i.id" class="border-t border-border/50">
                      <td class="py-1.5">{{ i.product_name }}</td>
                      <td class="py-1.5 text-right tabular-nums">{{ itemQtyUnit(i) }}</td>
                      <td class="py-1.5 text-right tabular-nums">{{ moneySum(i.price) }}</td>
                      <td class="py-1.5 text-right font-medium tabular-nums">{{ moneySum(i.subtotal) }}</td>
                    </tr>
                  </tbody>
                </table>
                <div class="mt-2 flex justify-end">
                  <button @click.stop="printSale(s)" class="flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 text-xs font-medium hover:bg-muted">
                    <Printer class="h-3.5 w-3.5" /> Chek chop etish
                  </button>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="visible.length === 0"><td colspan="8" class="px-4 py-12 text-center text-muted-foreground">Sotuv topilmadi</td></tr>
        </tbody>
        <tfoot v-if="visible.length" class="sticky bottom-0 border-t-2 bg-card text-sm font-semibold">
          <tr>
            <td></td>
            <td class="px-4 py-3" colspan="3">Jami: {{ totals.count }} ta</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(totals.total) }}</td>
            <td class="px-4 py-3 text-right tabular-nums text-emerald-600">{{ moneySum(totals.paid) }}</td>
            <td class="px-4 py-3 text-right tabular-nums text-rose-600">{{ moneySum(totals.debt) }}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>
</template>
