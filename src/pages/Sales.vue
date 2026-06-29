<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Receipt, ChevronDown, Search, Printer, Coins, Wallet, HandCoins } from 'lucide-vue-next'
import { listSales, listProducts, listCustomers, type SaleItem, type Product, type Customer } from '../lib/db'
import { moneySum, formatDateTime, translitMatch } from '../lib/format'
import SearchableSelect from '../components/SearchableSelect.vue'
import { printReceipt } from '../lib/print'

const { t } = useI18n()

function customerName(s: Row): string {
  return s.is_walk_in ? t('common.walkInCustomer') : (s.customer_name ?? '—')
}

function printSale(s: Row) {
  printReceipt({
    receipt_number: s.receipt_number,
    created_at: s.created_at,
    customer: customerName(s),
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

const statusLabels = computed<Record<string, string>>(() => ({
  paid: t('sales.statusPaid'), partial: t('sales.statusPartial'), debt: t('sales.statusDebt'), unpaid: t('sales.statusUnpaid'),
}))
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
    <header class="page-header">
      <h1 class="text-lg font-semibold">{{ $t('sales.title') }}</h1>
      <p class="truncate text-sm text-muted-foreground">{{ $t('sales.headerSummary', { count: totals.count, total: moneySum(totals.total), debt: moneySum(totals.debt) }) }}</p>
    </header>

    <!-- Stat kartalar -->
    <div class="grid grid-cols-2 gap-2.5 border-b px-4 py-3 sm:gap-3 sm:px-6 sm:py-4 lg:grid-cols-4">
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Receipt class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('sales.title') }}</div><div class="text-lg font-bold tabular-nums">{{ totals.count }}</div></div>
      </div>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600"><Coins class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('sales.totalAmount') }}</div><div class="text-lg font-bold tabular-nums">{{ moneySum(totals.total) }}</div></div>
      </div>
      <button @click="pickStatus('paid')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="status === 'paid' ? 'border-emerald-500 ring-1 ring-emerald-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><Wallet class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('sales.statusPaid') }}</div><div class="text-lg font-bold tabular-nums text-emerald-600">{{ moneySum(totals.paid) }}</div></div>
      </button>
      <button @click="pickStatus('debt')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="status === 'debt' ? 'border-rose-500 ring-1 ring-rose-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600"><HandCoins class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('sales.statusDebt') }}</div><div class="text-lg font-bold tabular-nums text-rose-600">{{ moneySum(totals.debt) }}</div></div>
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6">
      <div class="relative w-full sm:min-w-48 sm:flex-1">
        <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input v-model="search" :placeholder="$t('sales.receiptNumberPlaceholder')" class="h-9 w-full rounded-md border bg-background pl-9 pr-2 text-sm" />
      </div>
      <div class="w-full sm:w-52"><SearchableSelect v-model="customerId" :items="customerItems" :placeholder="$t('sales.allCustomers')" :search-placeholder="$t('sales.customerSearchPlaceholder')" clearable /></div>
      <div class="w-full sm:w-52"><SearchableSelect v-model="productId" :items="productItems" :placeholder="$t('sales.allProducts')" :search-placeholder="$t('sales.productSearchPlaceholder')" clearable /></div>
      <div class="flex w-full items-center gap-2 sm:w-auto">
        <input v-model="dateFrom" type="date" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:flex-none" />
        <span class="text-muted-foreground">—</span>
        <input v-model="dateTo" type="date" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:flex-none" />
      </div>
      <select v-model="status" class="h-9 w-full rounded-md border bg-card px-3 text-sm sm:w-auto">
        <option value="">{{ $t('sales.allStatuses') }}</option>
        <option value="paid">{{ $t('sales.statusPaid') }}</option>
        <option value="partial">{{ $t('sales.statusPartial') }}</option>
        <option value="debt">{{ $t('sales.statusDebt') }}</option>
      </select>
    </div>

    <div class="flex-1 overflow-auto pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-0">
      <!-- Mobil: kartalar ro'yxati -->
      <ul class="divide-y lg:hidden">
        <li v-for="s in visible" :key="s.id">
          <button type="button" class="flex w-full items-center gap-3 px-4 py-3 text-left" @click="toggle(s.id)">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="inline-flex items-center gap-1 truncate font-medium text-primary"><Receipt class="h-3.5 w-3.5 shrink-0" />{{ s.receipt_number }}</span>
                <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px]" :class="statusStyles[s.payment_status]">{{ statusLabels[s.payment_status] }}</span>
              </div>
              <div class="mt-0.5 truncate text-xs text-muted-foreground">{{ customerName(s) }} · {{ formatDateTime(s.created_at) }}</div>
            </div>
            <div class="shrink-0 text-right">
              <div class="font-semibold tabular-nums">{{ moneySum(s.total) }}</div>
              <div v-if="s.debt_amount > 0" class="text-xs text-rose-500 tabular-nums">{{ $t('sales.debtPrefix', { amount: moneySum(s.debt_amount) }) }}</div>
            </div>
            <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground transition-transform" :class="expanded.has(s.id) ? 'rotate-180' : ''" />
          </button>
          <div v-if="expanded.has(s.id)" class="bg-muted/20 px-4 py-3">
            <div v-for="i in s.items" :key="i.id" class="flex items-center justify-between gap-2 border-b border-border/40 py-1.5 text-xs last:border-0">
              <span class="min-w-0 flex-1 truncate">{{ i.product_name }}</span>
              <span class="shrink-0 text-muted-foreground tabular-nums">{{ itemQtyUnit(i) }} × {{ moneySum(i.price) }}</span>
              <span class="w-20 shrink-0 text-right font-medium tabular-nums">{{ moneySum(i.subtotal) }}</span>
            </div>
            <div class="mt-2 flex items-center justify-between">
              <span class="text-xs text-emerald-600 tabular-nums">{{ $t('sales.paidPrefix', { amount: moneySum(s.paid_amount) }) }}</span>
              <button @click.stop="printSale(s)" class="flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 text-xs font-medium"><Printer class="h-3.5 w-3.5" /> {{ $t('sales.receipt') }}</button>
            </div>
          </div>
        </li>
        <li v-if="visible.length === 0" class="px-4 py-12 text-center text-muted-foreground">{{ $t('sales.empty') }}</li>
        <li v-if="visible.length" class="flex justify-between bg-muted/40 px-4 py-3 text-sm font-semibold"><span>{{ $t('sales.totalCount', { count: totals.count }) }}</span><span class="tabular-nums">{{ moneySum(totals.total) }}</span></li>
      </ul>

      <table class="hidden w-full text-sm lg:table">
        <thead class="sticky top-0 z-10 border-b bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr>
            <th class="w-8 px-2 py-3"></th>
            <th class="px-4 py-3">{{ $t('sales.receipt') }}</th><th class="px-4 py-3">{{ $t('sales.customer') }}</th><th class="px-4 py-3">{{ $t('sales.time') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('sales.amount') }}</th><th class="px-4 py-3 text-right">{{ $t('sales.statusPaid') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('sales.statusDebt') }}</th><th class="px-4 py-3">{{ $t('sales.statusColumn') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <template v-for="s in visible" :key="s.id">
            <tr class="cursor-pointer hover:bg-muted/40" @click="toggle(s.id)">
              <td class="px-2 py-3 text-center text-muted-foreground"><ChevronDown class="inline h-4 w-4 transition-transform" :class="expanded.has(s.id) ? 'rotate-180' : ''" /></td>
              <td class="px-4 py-3"><span class="inline-flex items-center gap-1 font-medium text-primary"><Receipt class="h-3 w-3" />{{ s.receipt_number }}</span></td>
              <td class="px-4 py-3">{{ customerName(s) }}</td>
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
                  <thead class="text-left text-muted-foreground"><tr><th class="py-1">{{ $t('sales.product') }}</th><th class="py-1 text-right">{{ $t('sales.quantity') }}</th><th class="py-1 text-right">{{ $t('sales.price') }}</th><th class="py-1 text-right">{{ $t('sales.amount') }}</th></tr></thead>
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
                    <Printer class="h-3.5 w-3.5" /> {{ $t('sales.printReceipt') }}
                  </button>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="visible.length === 0"><td colspan="8" class="px-4 py-12 text-center text-muted-foreground">{{ $t('sales.empty') }}</td></tr>
        </tbody>
        <tfoot v-if="visible.length" class="sticky bottom-0 border-t-2 bg-card text-sm font-semibold">
          <tr>
            <td></td>
            <td class="px-4 py-3" colspan="3">{{ $t('sales.totalCount', { count: totals.count }) }}</td>
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
