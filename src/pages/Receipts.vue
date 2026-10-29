<script setup lang="ts">
// Kirimlar (prixod) bo'limi: barcha kirimlar + "Yangi kirim" + Excel. Bekor qilingan kirim
// o'chirilmaydi — ro'yxatda belgisi bilan qoladi, qoldig'i qaytarilgan.
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { PackagePlus, ChevronDown, Search, Plus, Ban, Truck } from 'lucide-vue-next'
import { listProducts, type Product } from '../lib/db'
import { listStockReceipts, voidStockReceipt, stockErrorMessage, type StockReceiptRow, type ReceiptStatus } from '../lib/stock'
import { moneySum, formatDateTime, translitMatch } from '../lib/format'
import { fmtQty } from '../lib/returns'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'
import SearchableSelect from '../components/SearchableSelect.vue'
import StockReceiptModal from '../components/StockReceiptModal.vue'

const { t } = useI18n()
const route = useRoute()

const rows = ref<StockReceiptRow[]>([])
const products = ref<Product[]>([])
const expanded = ref<Set<number>>(new Set())
// ?q= — Mahsulot harakatidan hujjatni ochish (kirim raqami).
const search = ref(typeof route.query.q === 'string' ? route.query.q : '')
const status = ref<ReceiptStatus | ''>('')
const productId = ref<number | null>(null)
const dateFrom = ref('')
const dateTo = ref('')
const showNew = ref(false)

async function load() {
  rows.value = await listStockReceipts({
    status: status.value || undefined,
    productId: productId.value || undefined,
    dateFrom: dateFrom.value || undefined,
    dateTo: dateTo.value || undefined,
  })
}
onMounted(async () => {
  products.value = await listProducts(false)
  await load()
})
watch([status, productId, dateFrom, dateTo], load)

// Qidiruv: kirim raqami, ta'minotchi, izoh, tovar nomi (kirill/lotin farqsiz).
const visible = computed(() => {
  const q = search.value.trim()
  if (!q) return rows.value
  return rows.value.filter((r) =>
    [r.receipt_number, r.supplier ?? '', r.note ?? '', ...r.items.map((i) => i.product_name)].some((x) => translitMatch(x, q)),
  )
})
// Jami faqat faol kirimlardan — bekor qilingani qoldiqqa ta'sir qilmaydi.
const totals = computed(() => {
  const act = visible.value.filter((r) => !r.voided_at)
  return {
    count: act.length,
    amount: act.reduce((s, r) => s + r.total, 0),
    suppliers: new Set(act.map((r) => r.supplier).filter(Boolean)).size,
    voided: visible.value.length - act.length,
  }
})
const productItems = computed(() => products.value.map((p) => ({ value: p.id, label: p.name })))
function toggle(id: number) { const n = new Set(expanded.value); n.has(id) ? n.delete(id) : n.add(id); expanded.value = n }
function pickVoided() { status.value = status.value === 'voided' ? '' : 'voided' }

async function voidReceipt(r: StockReceiptRow) {
  const ok = await confirmDialog(t('stock.voidConfirm', { number: r.receipt_number, total: moneySum(r.total) }), { title: t('stock.voidTitle'), danger: true, confirmText: t('stock.voidYes'), cancelText: t('common.no') })
  if (!ok) return
  try {
    await voidStockReceipt(r.id, null)
    notify(t('stock.voidedDone', { number: r.receipt_number }), 'success')
    await load()
  } catch (e) {
    notify(stockErrorMessage(e), 'error')
  }
}

</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="page-header flex items-center justify-between gap-2">
      <div class="min-w-0">
        <h1 class="text-lg font-semibold">{{ $t('stock.title') }}</h1>
        <p class="truncate text-sm text-muted-foreground">{{ $t('stock.headerSummary', { count: totals.count, total: moneySum(totals.amount) }) }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button @click="showNew = true" class="flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-sm font-medium text-white hover:bg-emerald-700">
          <Plus class="h-4 w-4" /> <span class="hidden sm:inline">{{ $t('stock.newReceipt') }}</span>
        </button>
      </div>
    </header>

    <div class="grid grid-cols-2 gap-2.5 border-b px-4 py-3 sm:gap-3 sm:px-6 sm:py-4 lg:grid-cols-3">
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><PackagePlus class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('stock.title') }} · {{ totals.count }}</div><div class="text-lg font-bold tabular-nums">{{ moneySum(totals.amount) }}</div></div>
      </div>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600"><Truck class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('stock.suppliers') }}</div><div class="text-lg font-bold tabular-nums">{{ totals.suppliers }}</div></div>
      </div>
      <button @click="pickVoided" class="col-span-2 flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm lg:col-span-1" :class="status === 'voided' ? 'border-rose-500 ring-1 ring-rose-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600"><Ban class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('stock.voidedPlural') }}</div><div class="text-lg font-bold tabular-nums">{{ totals.voided }}</div></div>
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6">
      <div class="relative w-full sm:min-w-48 sm:flex-1">
        <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input v-model="search" :placeholder="$t('stock.searchPlaceholder')" class="h-9 w-full rounded-md border bg-background pl-9 pr-2 text-sm" />
      </div>
      <div class="w-full sm:w-56"><SearchableSelect v-model="productId" :items="productItems" :placeholder="$t('sales.allProducts')" :search-placeholder="$t('sales.productSearchPlaceholder')" clearable /></div>
      <div class="flex w-full items-center gap-2 sm:w-auto">
        <input v-model="dateFrom" type="date" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:flex-none" />
        <span class="text-muted-foreground">—</span>
        <input v-model="dateTo" type="date" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:flex-none" />
      </div>
      <select v-model="status" class="h-9 w-full rounded-md border bg-card px-3 text-sm sm:w-auto">
        <option value="">{{ $t('common.all') }}</option>
        <option value="active">{{ $t('stock.active') }}</option>
        <option value="voided">{{ $t('stock.voidedPlural') }}</option>
      </select>
    </div>

    <div class="flex-1 overflow-auto pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-0">
      <!-- Mobil: kartalar -->
      <ul class="divide-y lg:hidden">
        <li v-for="r in visible" :key="r.id" :class="r.voided_at ? 'opacity-60' : ''">
          <button type="button" class="flex w-full items-center gap-3 px-4 py-3 text-left" @click="toggle(r.id)">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 truncate font-medium">
                {{ r.receipt_number }}
                <span v-if="r.voided_at" class="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-rose-600 uppercase">{{ $t('stock.voided') }}</span>
              </div>
              <div class="mt-0.5 truncate text-xs text-muted-foreground">{{ r.supplier || '—' }} · {{ formatDateTime(r.received_at) }}</div>
            </div>
            <div class="shrink-0 font-semibold tabular-nums" :class="r.voided_at ? 'line-through' : ''">{{ moneySum(r.total) }}</div>
            <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground transition-transform" :class="expanded.has(r.id) ? 'rotate-180' : ''" />
          </button>
          <div v-if="expanded.has(r.id)" class="space-y-2 bg-muted/20 px-4 py-3 text-xs">
            <div v-for="i in r.items" :key="i.id" class="flex justify-between gap-2">
              <span class="min-w-0 flex-1 truncate">{{ i.product_name }}</span>
              <span class="shrink-0 tabular-nums text-muted-foreground">{{ fmtQty(i.qty) }} {{ i.unit }} × {{ moneySum(i.cost_price) }}</span>
            </div>
            <div v-if="r.note" class="italic text-muted-foreground">«{{ r.note }}»</div>
            <div v-if="!r.voided_at" class="flex justify-end"><button @click.stop="voidReceipt(r)" class="flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 font-medium text-rose-600"><Ban class="h-3.5 w-3.5" /> {{ $t('stock.void') }}</button></div>
          </div>
        </li>
        <li v-if="visible.length === 0" class="px-4 py-16 text-center text-muted-foreground"><PackagePlus class="mx-auto mb-2 h-8 w-8 opacity-40" /> {{ $t('stock.empty') }}</li>
        <li v-if="totals.count" class="flex justify-between bg-muted/40 px-4 py-3 text-sm font-semibold"><span>{{ $t('sales.totalCount', { count: totals.count }) }}</span><span class="tabular-nums">{{ moneySum(totals.amount) }}</span></li>
      </ul>

      <table class="hidden w-full text-sm lg:table">
        <thead class="sticky top-0 z-10 border-b bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr>
            <th class="w-8 px-2 py-3"></th>
            <th class="px-4 py-3">{{ $t('stock.colNumber') }}</th>
            <th class="px-4 py-3">{{ $t('stock.date') }}</th>
            <th class="px-4 py-3">{{ $t('stock.supplier') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('stock.colLines') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('stock.colSum') }}</th>
            <th class="px-4 py-3">{{ $t('stock.note') }}</th>
            <th class="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <template v-for="r in visible" :key="r.id">
            <tr class="cursor-pointer hover:bg-muted/40" :class="r.voided_at ? 'opacity-60' : ''" @click="toggle(r.id)">
              <td class="px-2 py-3 text-center text-muted-foreground"><ChevronDown class="inline h-4 w-4 transition-transform" :class="expanded.has(r.id) ? 'rotate-180' : ''" /></td>
              <td class="px-4 py-3 font-medium">
                {{ r.receipt_number }}
                <span v-if="r.voided_at" class="ml-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-rose-600 uppercase">{{ $t('stock.voided') }}</span>
              </td>
              <td class="px-4 py-3 text-xs">{{ formatDateTime(r.received_at) }}</td>
              <td class="px-4 py-3">{{ r.supplier || '—' }}</td>
              <td class="px-4 py-3 text-right tabular-nums">{{ r.items.length }}</td>
              <td class="px-4 py-3 text-right font-semibold tabular-nums" :class="r.voided_at ? 'line-through' : ''">{{ moneySum(r.total) }}</td>
              <td class="max-w-64 truncate px-4 py-3 text-xs text-muted-foreground">{{ r.note }}</td>
              <td class="px-4 py-3 text-right">
                <button v-if="!r.voided_at" @click.stop="voidReceipt(r)" :title="$t('stock.void')" class="rounded p-1.5 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"><Ban class="h-4 w-4" /></button>
              </td>
            </tr>
            <tr v-if="expanded.has(r.id)" class="bg-muted/20">
              <td></td>
              <td colspan="7" class="px-4 py-3">
                <table class="w-full text-xs">
                  <thead class="text-left text-muted-foreground"><tr><th class="py-1">{{ $t('stock.colProduct') }}</th><th class="py-1 text-right">{{ $t('stock.colQty') }}</th><th class="py-1 text-right">{{ $t('stock.colCostShort') }}</th><th class="py-1 text-right">{{ $t('stock.colNewPrice') }}</th><th class="py-1 text-right">{{ $t('stock.colSum') }}</th></tr></thead>
                  <tbody>
                    <tr v-for="i in r.items" :key="i.id" class="border-t border-border/50">
                      <td class="py-1.5">{{ i.product_name }}</td>
                      <td class="py-1.5 text-right tabular-nums">{{ fmtQty(i.qty) }} {{ i.unit }}</td>
                      <td class="py-1.5 text-right tabular-nums">{{ moneySum(i.cost_price) }}</td>
                      <td class="py-1.5 text-right tabular-nums" :class="i.sale_price == null ? 'text-muted-foreground' : ''">{{ i.sale_price == null ? '—' : moneySum(i.sale_price) }}</td>
                      <td class="py-1.5 text-right font-medium tabular-nums">{{ moneySum(i.subtotal) }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-if="r.voided_at" class="mt-2 text-xs text-rose-600">{{ $t('stock.voidedAt', { date: formatDateTime(r.voided_at) }) }}<template v-if="r.void_reason"> · «{{ r.void_reason }}»</template></div>
              </td>
            </tr>
          </template>
          <tr v-if="visible.length === 0"><td colspan="8" class="px-4 py-16 text-center text-muted-foreground"><PackagePlus class="mx-auto mb-2 h-8 w-8 opacity-40" /> {{ $t('stock.empty') }}</td></tr>
        </tbody>
        <tfoot v-if="totals.count" class="sticky bottom-0 border-t-2 bg-card text-sm font-semibold">
          <tr>
            <td></td>
            <td class="px-4 py-3" colspan="4">{{ $t('sales.totalCount', { count: totals.count }) }}</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(totals.amount) }}</td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
    </div>

    <StockReceiptModal v-if="showNew" @close="showNew = false" @done="load" />
  </div>
</template>
