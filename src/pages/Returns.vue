<script setup lang="ts">
// Vozvratlar bo'limi: barcha qaytarishlar ro'yxati (chek va mijoz bo'yicha qilinganlar ham —
// ikkalasi ham har chekka alohida yozuv) + "Yangi vozvrat".
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import { RotateCcw, ChevronDown, Search, Printer, Coins, CreditCard, Wallet, Plus } from 'lucide-vue-next'
import { listReturns, listProducts, listCustomers, type ReturnListRow, type ReturnMethod, type Product, type Customer } from '../lib/db'
import { moneySum, formatDateTime, translitMatch } from '../lib/format'
import { printReturnReceipt, fmtQty } from '../lib/returns'
import SearchableSelect from '../components/SearchableSelect.vue'
import NewReturnModal from '../components/NewReturnModal.vue'
import ReturnSaleModal from '../components/ReturnSaleModal.vue'
import CustomerReturnModal from '../components/CustomerReturnModal.vue'

const { t } = useI18n()
const route = useRoute()

const rows = ref<ReturnListRow[]>([])
const products = ref<Product[]>([])
const customers = ref<Customer[]>([])
const expanded = ref<Set<number>>(new Set())
// ?q= — Mahsulot harakatidan hujjatni ochish (chek/vozvrat raqami).
const search = ref(typeof route.query.q === 'string' ? route.query.q : '')
const method = ref<ReturnMethod | ''>('')
const productId = ref<number | null>(null)
const customerId = ref<number | null>(null)
const dateFrom = ref('')
const dateTo = ref('')

// Yangi vozvrat oqimi: tanlash oynasi → chek yoki mijoz oynasi.
const showNew = ref(false)
const saleTarget = ref<{ id: number; label: string } | null>(null)
const customerTarget = ref<{ id: number; label: string } | null>(null)

function customerName(r: ReturnListRow): string {
  return r.is_walk_in ? t('common.walkInCustomer') : (r.customer_name ?? '—')
}

async function load() {
  rows.value = await listReturns({
    method: method.value || undefined,
    productId: productId.value || undefined,
    customerId: customerId.value || undefined,
    dateFrom: dateFrom.value || undefined,
    dateTo: dateTo.value || undefined,
  })
}
onMounted(async () => {
  ;[products.value, customers.value] = await Promise.all([listProducts(false), listCustomers()])
  await load()
})
watch([method, productId, customerId, dateFrom, dateTo], load)

// Qidiruv: vozvrat/chek raqami, mijoz, sabab, tovar nomi (kirill/lotin farqsiz).
const visible = computed(() => {
  const q = search.value.trim()
  if (!q) return rows.value
  return rows.value.filter((r) =>
    [r.return_number, r.receipt_number, customerName(r), r.reason ?? '', ...r.items.map((i) => i.product_name)].some((x) => translitMatch(x, q)),
  )
})
const totals = computed(() => ({
  count: visible.value.length,
  amount: visible.value.reduce((s, x) => s + x.amount, 0),
  cash: visible.value.reduce((s, x) => s + x.refund_cash, 0),
  card: visible.value.reduce((s, x) => s + x.refund_card, 0),
  balance: visible.value.reduce((s, x) => s + x.refund_balance, 0),
}))
const productItems = computed(() => products.value.map((p) => ({ value: p.id, label: p.name })))
const customerItems = computed(() => customers.value.map((c) => ({ value: c.id, label: c.is_walk_in ? t('common.walkInCustomer') : (c.phone ? `${c.name} · ${c.phone}` : c.name) })))
function pickMethod(v: ReturnMethod) { method.value = method.value === v ? '' : v }
function toggle(id: number) { const n = new Set(expanded.value); n.has(id) ? n.delete(id) : n.add(id); expanded.value = n }

function print(r: ReturnListRow) {
  void printReturnReceipt({
    return_number: r.return_number,
    receipt_number: r.receipt_number,
    created_at: r.created_at,
    customer: customerName(r),
    items: r.items.map((i) => ({ name: i.product_name, qty: i.qty, unit: i.unit, price: i.price, subtotal: i.subtotal })),
    amount: r.amount,
    refund_cash: r.refund_cash,
    refund_card: r.refund_card,
    refund_balance: r.refund_balance,
  })
}

function onPickSale(id: number, label: string) { showNew.value = false; saleTarget.value = { id, label } }
function onPickCustomer(id: number, label: string) { showNew.value = false; customerTarget.value = { id, label } }
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="page-header flex items-center justify-between gap-2">
      <div class="min-w-0">
        <h1 class="text-lg font-semibold">{{ $t('returnsPage.title') }}</h1>
        <p class="truncate text-sm text-muted-foreground">{{ $t('returnsPage.headerSummary', { count: totals.count, total: moneySum(totals.amount) }) }}</p>
      </div>
      <button @click="showNew = true" class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 text-sm font-medium text-white hover:bg-amber-700">
        <Plus class="h-4 w-4" /> <span class="hidden sm:inline">{{ $t('returnsPage.newReturn') }}</span>
      </button>
    </header>

    <!-- Stat kartalar (usul kartalari bosilsa — filter) -->
    <div class="grid grid-cols-2 gap-2.5 border-b px-4 py-3 sm:gap-3 sm:px-6 sm:py-4 lg:grid-cols-4">
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600"><RotateCcw class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('returnsPage.title') }} · {{ totals.count }}</div><div class="text-lg font-bold tabular-nums">{{ moneySum(totals.amount) }}</div></div>
      </div>
      <button @click="pickMethod('cash')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="method === 'cash' ? 'border-emerald-500 ring-1 ring-emerald-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><Coins class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('returns.refundCash') }}</div><div class="text-lg font-bold tabular-nums">{{ moneySum(totals.cash) }}</div></div>
      </button>
      <button @click="pickMethod('card')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="method === 'card' ? 'border-sky-500 ring-1 ring-sky-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600"><CreditCard class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('returns.refundCard') }}</div><div class="text-lg font-bold tabular-nums">{{ moneySum(totals.card) }}</div></div>
      </button>
      <button @click="pickMethod('balance')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="method === 'balance' ? 'border-violet-500 ring-1 ring-violet-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600"><Wallet class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('returns.refundBalance') }}</div><div class="text-lg font-bold tabular-nums">{{ moneySum(totals.balance) }}</div></div>
      </button>
    </div>

    <!-- Filtrlar -->
    <div class="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6">
      <div class="relative w-full sm:min-w-48 sm:flex-1">
        <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input v-model="search" :placeholder="$t('returnsPage.searchPlaceholder')" class="h-9 w-full rounded-md border bg-background pl-9 pr-2 text-sm" />
      </div>
      <div class="w-full sm:w-52"><SearchableSelect v-model="customerId" :items="customerItems" :placeholder="$t('sales.allCustomers')" :search-placeholder="$t('sales.customerSearchPlaceholder')" clearable /></div>
      <div class="w-full sm:w-52"><SearchableSelect v-model="productId" :items="productItems" :placeholder="$t('sales.allProducts')" :search-placeholder="$t('sales.productSearchPlaceholder')" clearable /></div>
      <div class="flex w-full items-center gap-2 sm:w-auto">
        <input v-model="dateFrom" type="date" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:flex-none" />
        <span class="text-muted-foreground">—</span>
        <input v-model="dateTo" type="date" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:flex-none" />
      </div>
      <select v-model="method" class="h-9 w-full rounded-md border bg-card px-3 text-sm sm:w-auto">
        <option value="">{{ $t('returnsPage.allMethods') }}</option>
        <option value="cash">{{ $t('returns.refundCash') }}</option>
        <option value="card">{{ $t('returns.refundCard') }}</option>
        <option value="balance">{{ $t('returns.refundBalance') }}</option>
      </select>
    </div>

    <div class="flex-1 overflow-auto pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-0">
      <!-- Mobil: kartalar -->
      <ul class="divide-y lg:hidden">
        <li v-for="r in visible" :key="r.id">
          <button type="button" class="flex w-full items-center gap-3 px-4 py-3 text-left" @click="toggle(r.id)">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 truncate font-medium text-amber-700 dark:text-amber-400"><RotateCcw class="h-3.5 w-3.5 shrink-0" />{{ r.return_number }}</div>
              <div class="mt-0.5 truncate text-xs text-muted-foreground">{{ customerName(r) }} · {{ formatDateTime(r.created_at) }}</div>
            </div>
            <div class="shrink-0 font-semibold tabular-nums">− {{ moneySum(r.amount) }}</div>
            <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground transition-transform" :class="expanded.has(r.id) ? 'rotate-180' : ''" />
          </button>
          <div v-if="expanded.has(r.id)" class="space-y-2 bg-muted/20 px-4 py-3 text-xs">
            <div class="text-muted-foreground">{{ $t('print.originalReceipt') }} #{{ r.receipt_number }}</div>
            <div v-for="i in r.items" :key="i.id" class="flex justify-between gap-2">
              <span class="min-w-0 flex-1 truncate">{{ i.product_name }}</span>
              <span class="shrink-0 tabular-nums text-muted-foreground">{{ fmtQty(i.qty) }} {{ i.unit }} × {{ moneySum(i.price) }}</span>
            </div>
            <div class="flex flex-wrap gap-x-3 border-t pt-2 tabular-nums">
              <span v-if="r.refund_cash > 0">{{ $t('returns.refundCash') }} {{ moneySum(r.refund_cash) }}</span>
              <span v-if="r.refund_card > 0">{{ $t('returns.refundCard') }} {{ moneySum(r.refund_card) }}</span>
              <span v-if="r.refund_balance > 0">{{ $t('returns.refundBalance') }} {{ moneySum(r.refund_balance) }}</span>
            </div>
            <div v-if="r.reason" class="italic text-muted-foreground">«{{ r.reason }}»</div>
            <div class="flex justify-end"><button @click.stop="print(r)" class="flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 font-medium"><Printer class="h-3.5 w-3.5" /> {{ $t('returns.printReceipt') }}</button></div>
          </div>
        </li>
        <li v-if="visible.length === 0" class="px-4 py-16 text-center text-muted-foreground"><RotateCcw class="mx-auto mb-2 h-8 w-8 opacity-40" /> {{ $t('returnsPage.empty') }}</li>
        <li v-if="visible.length" class="flex justify-between bg-muted/40 px-4 py-3 text-sm font-semibold"><span>{{ $t('sales.totalCount', { count: totals.count }) }}</span><span class="tabular-nums">− {{ moneySum(totals.amount) }}</span></li>
      </ul>

      <table class="hidden w-full text-sm lg:table">
        <thead class="sticky top-0 z-10 border-b bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr>
            <th class="w-8 px-2 py-3"></th>
            <th class="px-4 py-3">{{ $t('returnsPage.colNumber') }}</th>
            <th class="px-4 py-3">{{ $t('returnsPage.colReceipt') }}</th>
            <th class="px-4 py-3">{{ $t('sales.customer') }}</th>
            <th class="px-4 py-3">{{ $t('sales.time') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('sales.amount') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('returns.refundCash') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('returns.refundCard') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('returns.refundBalance') }}</th>
            <th class="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <template v-for="r in visible" :key="r.id">
            <tr class="cursor-pointer hover:bg-muted/40" @click="toggle(r.id)">
              <td class="px-2 py-3 text-center text-muted-foreground"><ChevronDown class="inline h-4 w-4 transition-transform" :class="expanded.has(r.id) ? 'rotate-180' : ''" /></td>
              <td class="px-4 py-3"><span class="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400"><RotateCcw class="h-3 w-3" />{{ r.return_number }}</span></td>
              <td class="px-4 py-3 text-muted-foreground">#{{ r.receipt_number }}</td>
              <td class="px-4 py-3">
                <RouterLink v-if="r.customer_id && !r.is_walk_in" :to="`/customers/${r.customer_id}`" @click.stop class="hover:underline">{{ customerName(r) }}</RouterLink>
                <span v-else>{{ customerName(r) }}</span>
              </td>
              <td class="px-4 py-3 text-xs">{{ formatDateTime(r.created_at) }}</td>
              <td class="px-4 py-3 text-right font-semibold tabular-nums">− {{ moneySum(r.amount) }}</td>
              <td class="px-4 py-3 text-right tabular-nums" :class="r.refund_cash > 0 ? '' : 'text-muted-foreground'">{{ r.refund_cash > 0 ? moneySum(r.refund_cash) : '—' }}</td>
              <td class="px-4 py-3 text-right tabular-nums" :class="r.refund_card > 0 ? '' : 'text-muted-foreground'">{{ r.refund_card > 0 ? moneySum(r.refund_card) : '—' }}</td>
              <td class="px-4 py-3 text-right tabular-nums" :class="r.refund_balance > 0 ? '' : 'text-muted-foreground'">{{ r.refund_balance > 0 ? moneySum(r.refund_balance) : '—' }}</td>
              <td class="px-4 py-3 text-right"><button @click.stop="print(r)" class="rounded p-1.5 hover:bg-muted" :title="$t('returns.printReceipt')"><Printer class="h-4 w-4" /></button></td>
            </tr>
            <tr v-if="expanded.has(r.id)" class="bg-muted/20">
              <td></td>
              <td colspan="9" class="px-4 py-3">
                <table class="w-full text-xs">
                  <thead class="text-left text-muted-foreground"><tr><th class="py-1">{{ $t('sales.product') }}</th><th class="py-1 text-right">{{ $t('sales.quantity') }}</th><th class="py-1 text-right">{{ $t('sales.price') }}</th><th class="py-1 text-right">{{ $t('sales.amount') }}</th></tr></thead>
                  <tbody>
                    <tr v-for="i in r.items" :key="i.id" class="border-t border-border/50">
                      <td class="py-1.5">{{ i.product_name }}</td>
                      <td class="py-1.5 text-right tabular-nums">{{ fmtQty(i.qty) }} {{ i.unit }}</td>
                      <td class="py-1.5 text-right tabular-nums">{{ moneySum(i.price) }}</td>
                      <td class="py-1.5 text-right font-medium tabular-nums">{{ moneySum(i.subtotal) }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-if="r.reason" class="mt-2 text-xs italic text-muted-foreground">{{ $t('returns.reason') }}: «{{ r.reason }}»</div>
              </td>
            </tr>
          </template>
          <tr v-if="visible.length === 0"><td colspan="10" class="px-4 py-16 text-center text-muted-foreground"><RotateCcw class="mx-auto mb-2 h-8 w-8 opacity-40" /> {{ $t('returnsPage.empty') }}</td></tr>
        </tbody>
        <tfoot v-if="visible.length" class="sticky bottom-0 border-t-2 bg-card text-sm font-semibold">
          <tr>
            <td></td>
            <td class="px-4 py-3" colspan="4">{{ $t('sales.totalCount', { count: totals.count }) }}</td>
            <td class="px-4 py-3 text-right tabular-nums">− {{ moneySum(totals.amount) }}</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(totals.cash) }}</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(totals.card) }}</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(totals.balance) }}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>

    <NewReturnModal v-if="showNew" @close="showNew = false" @sale="onPickSale" @customer="onPickCustomer" />
    <ReturnSaleModal v-if="saleTarget" :sale-id="saleTarget.id" :customer-label="saleTarget.label" @close="saleTarget = null" @done="load" />
    <CustomerReturnModal v-if="customerTarget" :customer-id="customerTarget.id" :customer-label="customerTarget.label" @close="customerTarget = null" @done="load" />
  </div>
</template>
