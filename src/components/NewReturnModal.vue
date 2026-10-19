<script setup lang="ts">
// "Yangi vozvrat" — qaysi yo'l bilan: chek bo'yicha (raqam qidiriladi) yoki mijoz bo'yicha.
// Bu oyna faqat tanlaydi; vozvratni ReturnSaleModal / CustomerReturnModal bajaradi.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCcw, Search, Receipt, ChevronRight } from 'lucide-vue-next'
import { listSales, listCustomers, type Customer, type SaleListRow } from '../lib/db'
import { moneySum, formatDateTime } from '../lib/format'
import { saleReturnState } from '../lib/returns'
import SearchableSelect from './SearchableSelect.vue'

const emit = defineEmits<{
  close: []
  sale: [saleId: number, customerLabel: string]
  customer: [customerId: number, customerLabel: string]
}>()
const { t } = useI18n()

const mode = ref<'receipt' | 'customer'>('receipt')
const query = ref('')
const queryInput = ref<HTMLInputElement | null>(null)
const sales = ref<SaleListRow[]>([])
const searching = ref(false)
const customers = ref<Customer[]>([])
const customerId = ref<number | null>(null)

const customerLabel = (s: SaleListRow) => (s.is_walk_in ? t('common.walkInCustomer') : (s.customer_name ?? '—'))
// Mijoz bo'yicha faqat nomli va faol mijozlar (yo'l-yo'lakay — chek bo'yicha).
const customerItems = computed(() =>
  customers.value
    .filter((c) => !c.is_walk_in)
    .map((c) => ({ value: c.id, label: c.phone ? `${c.name} · ${c.phone}` : c.name })),
)

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null
async function search() {
  const my = ++seq
  searching.value = true
  try {
    const rows = await listSales({ search: query.value.trim() || undefined })
    if (my === seq) sales.value = rows.slice(0, 20)
  } finally {
    if (my === seq) searching.value = false
  }
}
watch(query, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void search(), 200)
})
onMounted(async () => {
  // `autofocus` dinamik ochilgan oynada ishlamaydi — kassir darhol chek raqamini yozadi.
  void nextTick(() => queryInput.value?.focus())
  void search()
  customers.value = await listCustomers(true)
})
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

function pickSale(s: SaleListRow) {
  if (saleReturnState(s) === 'full') return
  emit('sale', s.id, customerLabel(s))
}
function pickCustomer() {
  const c = customers.value.find((x) => x.id === customerId.value)
  if (c) emit('customer', c.id, c.name)
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-3 sm:p-4 sm:pt-[8vh]">
    <div class="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-card shadow-xl">
      <div class="flex items-center gap-2 border-b px-4 py-3">
        <RotateCcw class="h-4.5 w-4.5 text-amber-600" />
        <div class="flex-1 font-semibold">{{ $t('returnsPage.newReturn') }}</div>
      </div>

      <div class="flex gap-1.5 border-b p-3">
        <button @click="mode = 'receipt'; nextTick(() => queryInput?.focus())" class="h-9 flex-1 rounded-md border text-sm font-medium" :class="mode === 'receipt' ? 'border-primary bg-primary/10 text-primary' : ''">{{ $t('returnsPage.byReceipt') }}</button>
        <button @click="mode = 'customer'" class="h-9 flex-1 rounded-md border text-sm font-medium" :class="mode === 'customer' ? 'border-primary bg-primary/10 text-primary' : ''">{{ $t('returnsPage.byCustomer') }}</button>
      </div>

      <!-- Chek bo'yicha -->
      <template v-if="mode === 'receipt'">
        <div class="p-3 pb-0">
          <div class="relative">
            <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input ref="queryInput" v-model="query" :placeholder="$t('sales.receiptNumberPlaceholder')" class="h-10 w-full rounded-md border bg-background pl-9 pr-2 text-sm" />
          </div>
        </div>
        <ul class="min-h-[16rem] flex-1 divide-y overflow-y-auto p-3">
          <li v-for="s in sales" :key="s.id">
            <button @click="pickSale(s)" :disabled="saleReturnState(s) === 'full'"
              class="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50">
              <Receipt class="h-4 w-4 shrink-0 text-muted-foreground" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 text-sm font-medium">
                  {{ s.receipt_number }}
                  <span v-if="saleReturnState(s)" class="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-normal text-amber-700 dark:text-amber-400">{{ saleReturnState(s) === 'full' ? $t('returns.fullyReturned') : $t('returns.partiallyReturned') }}</span>
                </div>
                <div class="truncate text-xs text-muted-foreground">{{ customerLabel(s) }} · {{ formatDateTime(s.created_at) }}</div>
              </div>
              <span class="shrink-0 text-sm font-semibold tabular-nums">{{ moneySum(s.total) }}</span>
              <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
          <li v-if="!searching && sales.length === 0" class="py-10 text-center text-sm text-muted-foreground">{{ $t('sales.empty') }}</li>
        </ul>
      </template>

      <!-- Mijoz bo'yicha -->
      <div v-else class="min-h-[18rem] flex-1 space-y-3 p-3">
        <p class="text-xs text-muted-foreground">{{ $t('returns.customerHint') }}</p>
        <SearchableSelect v-model="customerId" :items="customerItems" :placeholder="$t('returnsPage.pickCustomer')" :search-placeholder="$t('sales.customerSearchPlaceholder')" />
        <button @click="pickCustomer" :disabled="!customerId" class="h-10 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{{ $t('returnsPage.continue') }}</button>
      </div>

      <div class="flex justify-end border-t px-4 py-3">
        <button @click="emit('close')" class="h-10 rounded-md border px-4 text-sm hover:bg-muted">{{ $t('common.cancel') }}</button>
      </div>
    </div>
  </div>
</template>
