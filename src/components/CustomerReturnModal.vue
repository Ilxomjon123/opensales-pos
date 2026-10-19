<script setup lang="ts">
// Mijoz bo'yicha vozvrat: chek qidirilmaydi — tovar va miqdor tanlanadi, Rust uni mijozning
// cheklariga eng yangisidan boshlab taqsimlaydi (customer_return_quote). UI hisoblamaydi.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCcw, Printer, AlertTriangle, CheckCircle2, X, Receipt } from 'lucide-vue-next'
import { moneySum, formatDateTime } from '../lib/format'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'
import SearchableSelect from './SearchableSelect.vue'
import RefundSplit from './RefundSplit.vue'
import {
  customerReturnQuote, createCustomerReturn, returnErrorMessage, printReturnReceipt, customerResultToReceipt,
  fmtQty, clampRefundBalance,
  type CustomerReturnQuote, type CustomerReturnResult, type ReturnableProduct,
} from '../lib/returns'

const props = defineProps<{ customerId: number; customerLabel: string }>()
const emit = defineEmits<{ close: []; done: [r: CustomerReturnResult] }>()
const { t } = useI18n()

const quote = ref<CustomerReturnQuote | null>(null)
// Tanlangan tovarlar tartibi (qo'shilgan ketma-ketlikda) va miqdorlari.
const chosen = ref<number[]>([])
const qty = ref<Record<number, number>>({})
const picker = ref<number | null>(null)
const refundBalance = ref(0)
const balanceTouched = ref(false)
const method = ref<'cash' | 'card'>('cash')
const reason = ref('')
const error = ref('')
const busy = ref(false)
const loading = ref(true)
const result = ref<CustomerReturnResult | null>(null)

// Mahsulot ro'yxati birinchi javobdan olinadi va o'zgarmaydi — tanlovdan keyin "qoldi"
// raqamlari sakrab ketmasligi uchun (qaytarilgunga qadar qoldiq o'zgarmaydi).
const products = ref<ReturnableProduct[]>([])
const productById = computed(() => new Map(products.value.map((p) => [p.productId, p])))
const pickerItems = computed(() =>
  products.value
    .filter((p) => !chosen.value.includes(p.productId))
    .map((p) => ({ value: p.productId, label: `${p.productName} · ${t('returns.remainingShort', { qty: fmtQty(p.qtyRemaining), unit: p.unit })}` })),
)
const selected = computed(() =>
  chosen.value.map((id) => ({ productId: id, qty: qty.value[id] ?? 0 })).filter((l) => l.qty > 0),
)
const amount = computed(() => quote.value?.amount ?? 0)
const canSubmit = computed(() => !!quote.value?.shiftOpen && selected.value.length > 0 && !busy.value && !error.value)

function clampBalance(v: number): number {
  const q = quote.value
  return q ? clampRefundBalance(v, q.amount, q.moneyCap, true) : 0
}

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null
async function requote(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  const my = ++seq
  try {
    const q = await customerReturnQuote(props.customerId, selected.value)
    if (my !== seq) return
    quote.value = q
    if (products.value.length === 0) products.value = q.products
    error.value = ''
    refundBalance.value = clampBalance(balanceTouched.value ? refundBalance.value : q.suggestedBalance)
  } catch (e) {
    if (my === seq) error.value = returnErrorMessage(e)
  } finally {
    if (my === seq) loading.value = false
  }
}
watch(selected, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void requote(), 150)
}, { deep: true })
onMounted(requote)
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

// Tanlangan tovar ro'yxatga qo'shiladi (1 birlik yoki qolgani kamroq bo'lsa — qolgani).
watch(picker, (id) => {
  if (id == null) return
  const p = productById.value.get(Number(id))
  if (p && !chosen.value.includes(p.productId)) {
    chosen.value = [...chosen.value, p.productId]
    qty.value = { ...qty.value, [p.productId]: Math.min(1, p.qtyRemaining) }
  }
  picker.value = null
})

function setQty(id: number, raw: unknown) {
  const max = productById.value.get(id)?.qtyRemaining ?? 0
  const n = Number(raw)
  const v = Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n * 1000) / 1000)) : 0
  qty.value = { ...qty.value, [id]: v }
}
function onQtyInput(id: number, raw: string) {
  if (raw === '' || /[.,]$/.test(raw)) return
  setQty(id, raw)
}
function remove(id: number) {
  chosen.value = chosen.value.filter((x) => x !== id)
  const { [id]: _, ...rest } = qty.value
  qty.value = rest
}
function onBalance(v: number) { balanceTouched.value = true; refundBalance.value = v }

async function submit() {
  if (busy.value) return
  await requote()
  const q = quote.value
  if (!q || error.value) return
  if (!q.shiftOpen) { error.value = t('returns.shiftClosed'); return }
  if (selected.value.length === 0) { error.value = t('returns.nothingSelected'); return }
  const ok = await confirmDialog(
    t('returns.confirmMany', { amount: moneySum(q.amount), count: q.allocations.length }),
    { title: t('returns.confirmTitle'), danger: true },
  )
  if (!ok) return
  busy.value = true
  try {
    const bal = clampBalance(refundBalance.value)
    const money = q.amount - bal
    const r = await createCustomerReturn({
      customerId: props.customerId,
      lines: selected.value,
      refundCash: method.value === 'cash' ? money : 0,
      refundCard: method.value === 'card' ? money : 0,
      refundBalance: bal,
      reason: reason.value.trim() || null,
    })
    result.value = r
    notify(t('returns.doneMany', { count: r.returns.length }), 'success')
    emit('done', r)
  } catch (e) {
    const msg = returnErrorMessage(e)
    await requote()
    error.value = msg
  } finally {
    busy.value = false
  }
}

function print() {
  if (result.value) void printReturnReceipt(customerResultToReceipt(result.value, props.customerLabel))
}
</script>

<template>
  <!-- Tepaga mahkamlangan: tovar qo'shilganda oyna pastga o'sadi, qatorlar kursor ostidan siljimaydi. -->
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-3 sm:p-4 sm:pt-[6vh]">
    <div class="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-card shadow-xl sm:max-h-[88vh]">
      <div class="flex items-center gap-2 border-b px-4 py-3 sm:px-5">
        <RotateCcw class="h-4.5 w-4.5 shrink-0 text-amber-600" />
        <div class="min-w-0 flex-1">
          <div class="truncate font-semibold">{{ $t('returns.customerTitle') }}</div>
          <div class="truncate text-xs text-muted-foreground">{{ customerLabel }}</div>
        </div>
      </div>

      <!-- Bajarildi -->
      <div v-if="result" class="space-y-4 p-5 text-center">
        <CheckCircle2 class="mx-auto h-10 w-10 text-emerald-600" />
        <div>
          <div class="text-lg font-semibold">{{ $t('returns.doneMany', { count: result.returns.length }) }}</div>
          <div class="mt-1 text-2xl font-bold tabular-nums">{{ moneySum(result.amount) }}</div>
          <div class="mt-1 text-xs text-muted-foreground">{{ result.returns.map((r) => r.returnNumber).join(', ') }}</div>
        </div>
        <div class="mx-auto max-w-xs space-y-1 rounded-lg bg-muted/40 p-3 text-sm">
          <div v-if="result.refundCash > 0" class="flex justify-between"><span class="text-muted-foreground">{{ $t('returns.refundCash') }}</span><span class="tabular-nums">{{ moneySum(result.refundCash) }}</span></div>
          <div v-if="result.refundCard > 0" class="flex justify-between"><span class="text-muted-foreground">{{ $t('returns.refundCard') }}</span><span class="tabular-nums">{{ moneySum(result.refundCard) }}</span></div>
          <div v-if="result.refundBalance > 0" class="flex justify-between"><span class="text-muted-foreground">{{ $t('returns.refundBalance') }}</span><span class="tabular-nums">{{ moneySum(result.refundBalance) }}</span></div>
        </div>
        <div class="flex gap-2">
          <button @click="print" class="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md border text-sm font-medium hover:bg-muted"><Printer class="h-4 w-4" /> {{ $t('returns.printReceipt') }}</button>
          <button @click="emit('close')" class="h-10 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">{{ $t('common.close') }}</button>
        </div>
      </div>

      <template v-else>
        <!-- min-h: oyna bo'sh paytda tovar ro'yxati (dropdown) scroll-konteyner ichida kesilmasin. -->
        <div class="min-h-[24rem] flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          <div v-if="loading" class="py-10 text-center text-sm text-muted-foreground">…</div>
          <template v-else-if="quote">
            <div v-if="!quote.shiftOpen" class="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" /> {{ $t('returns.shiftClosed') }}
            </div>

            <div v-if="products.length === 0" class="rounded-lg border p-6 text-center text-sm text-muted-foreground">{{ $t('returns.noReturnable') }}</div>
            <template v-else>
              <p class="text-xs text-muted-foreground">{{ $t('returns.customerHint') }}</p>
              <SearchableSelect v-model="picker" :items="pickerItems" :placeholder="$t('returns.addProduct')" :search-placeholder="$t('returns.productSearch')" />

              <!-- Tanlangan tovarlar -->
              <ul v-if="chosen.length" class="divide-y overflow-hidden rounded-lg border">
                <li v-for="id in chosen" :key="id" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                  <div class="min-w-0 flex-1 basis-48">
                    <div class="truncate text-sm font-medium">{{ productById.get(id)?.productName }}</div>
                    <div class="text-xs text-muted-foreground tabular-nums">
                      {{ $t('returns.remainingShort', { qty: fmtQty(productById.get(id)?.qtyRemaining ?? 0), unit: productById.get(id)?.unit ?? '' }) }}
                      · {{ $t('returns.lastPrice', { price: moneySum(productById.get(id)?.lastPrice ?? 0) }) }}
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <input
                      type="number" min="0" :max="productById.get(id)?.qtyRemaining" step="any"
                      :value="qty[id] ?? 0"
                      @change="setQty(id, ($event.target as HTMLInputElement).value)"
                      @input="onQtyInput(id, ($event.target as HTMLInputElement).value)"
                      class="h-9 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums"
                    />
                    <button @click="setQty(id, productById.get(id)?.qtyRemaining ?? 0)" class="h-9 rounded-md border px-2.5 text-xs font-medium hover:bg-muted">{{ $t('returns.all') }}</button>
                    <button @click="remove(id)" :title="$t('returns.remove')" class="flex h-9 w-9 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted"><X class="h-4 w-4" /></button>
                  </div>
                </li>
              </ul>

              <!-- Cheklar bo'yicha taqsimot (Rust hisoblagan) -->
              <div v-if="quote.allocations.length" class="overflow-hidden rounded-lg border">
                <div class="border-b bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('returns.byReceipts') }}</div>
                <div v-for="a in quote.allocations" :key="a.saleId" class="flex items-start gap-2 border-b px-3 py-2 text-xs last:border-0">
                  <Receipt class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div class="min-w-0 flex-1">
                    <div class="font-medium">#{{ a.receiptNumber }} <span class="font-normal text-muted-foreground">· {{ formatDateTime(a.createdAt) }}</span></div>
                    <div class="text-muted-foreground">{{ a.lines.map((l) => `${l.productName} × ${fmtQty(l.qty)}`).join(', ') }}</div>
                  </div>
                  <span class="shrink-0 font-semibold tabular-nums">{{ moneySum(a.amount) }}</span>
                </div>
              </div>

              <!-- Summa va taqsimot -->
              <div class="space-y-3 rounded-lg border p-3">
                <div class="flex items-baseline justify-between">
                  <span class="text-sm text-muted-foreground">{{ $t('returns.amount') }}</span>
                  <span class="text-2xl font-bold tabular-nums">{{ moneySum(amount) }}</span>
                </div>
                <RefundSplit :amount="amount" :money-cap="quote.moneyCap" :balance-allowed="true" :customer-balance="quote.customerBalance"
                  :balance="refundBalance" @update:balance="onBalance" v-model:method="method" />
              </div>

              <div>
                <label class="mb-1 block text-sm font-medium">{{ $t('returns.reason') }}</label>
                <textarea v-model="reason" maxlength="500" rows="2" :placeholder="$t('returns.reasonPlaceholder')" class="w-full rounded-md border bg-background px-3 py-2 text-sm"></textarea>
              </div>
            </template>
          </template>

          <div v-if="error" class="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-600">{{ error }}</div>
        </div>

        <div class="flex gap-2 border-t px-4 py-3 sm:px-5">
          <button @click="submit" :disabled="!canSubmit" class="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md bg-amber-600 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
            <RotateCcw class="h-4 w-4" /> {{ $t('returns.submit') }}<template v-if="amount > 0"> · {{ moneySum(amount) }}</template>
          </button>
          <button @click="emit('close')" :disabled="busy" class="h-10 rounded-md border px-4 text-sm hover:bg-muted disabled:opacity-50">{{ $t('common.cancel') }}</button>
        </div>
      </template>
    </div>
  </div>
</template>
