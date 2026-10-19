<script setup lang="ts">
// Sotuvni qaytarish (vozvrat) oynasi. Summa, cheklar va taqsimot taklifi Rust'dan keladi
// (return_quote) — UI faqat miqdor va pul taqsimotini tanlaydi, hisoblamaydi.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCcw, Printer, AlertTriangle, CheckCircle2 } from 'lucide-vue-next'
import { moneySum } from '../lib/format'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'
import {
  returnQuote, createReturn, returnErrorMessage, printReturnReceipt, createdToReceipt, fmtQty, clampRefundBalance,
  type ReturnQuote, type CreatedReturn,
} from '../lib/returns'
import RefundSplit from './RefundSplit.vue'

const props = defineProps<{ saleId: number; customerLabel: string }>()
const emit = defineEmits<{ close: []; done: [r: CreatedReturn] }>()
const { t } = useI18n()

const quote = ref<ReturnQuote | null>(null)
const qty = ref<Record<number, number>>({})
const refundBalance = ref(0)
const balanceTouched = ref(false) // kassir o'zgartirgan bo'lsa taklif ustidan yozmaymiz
const method = ref<'cash' | 'card'>('cash')
const reason = ref('')
const error = ref('')
const busy = ref(false)
const loading = ref(true)
const created = ref<CreatedReturn | null>(null)

const lines = computed(() => quote.value?.lines ?? [])
const selected = computed(() =>
  lines.value
    .map((l) => ({ saleItemId: l.saleItemId, qty: qty.value[l.saleItemId] ?? 0 }))
    .filter((l) => l.qty > 0),
)
const amount = computed(() => quote.value?.amount ?? 0)
const anyReturnable = computed(() => lines.value.some((l) => l.qtyRemaining > 1e-6))
const canSubmit = computed(() => !!quote.value?.shiftOpen && selected.value.length > 0 && !busy.value && !error.value)

function clampBalance(v: number): number {
  const q = quote.value
  return q ? clampRefundBalance(v, q.amount, q.moneyCap, q.balanceAllowed) : 0
}

// Har miqdor o'zgarishida Rust qayta hisoblaydi. Eski javob yangisini bosib ketmasin — seq.
let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null
async function requote(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  const my = ++seq
  try {
    const q = await returnQuote(props.saleId, selected.value)
    if (my !== seq) return
    quote.value = q
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
  timer = setTimeout(() => void requote(), 120)
}, { deep: true })
onMounted(requote)
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

// Kiritilgan miqdorni [0, qolgan] oralig'iga keltiradi (3 xona). Bo'sh/noto'g'ri = 0.
function setQty(id: number, raw: unknown, max: number) {
  const n = Number(raw)
  const v = Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n * 1000) / 1000)) : 0
  qty.value = { ...qty.value, [id]: v }
}
// Yozish paytida: chala qiymatni ("1.", "") bosib yubormaymiz — aks holda kasr kiritib bo'lmaydi.
// To'liq tekshiruv @change'da (fokus chiqqanda).
function onQtyInput(id: number, raw: string, max: number) {
  if (raw === '' || /[.,]$/.test(raw)) return
  setQty(id, raw, max)
}
function selectAll() {
  const next: Record<number, number> = {}
  for (const l of lines.value) next[l.saleItemId] = l.qtyRemaining
  qty.value = next
}
function clearAll() { qty.value = {} }
function onBalance(v: number) {
  balanceTouched.value = true
  refundBalance.value = v
}
function isIntegerUnit(l: { qtySold: number }) { return Number.isInteger(l.qtySold) }

async function submit() {
  if (busy.value) return
  // Debounce kutib turgan bo'lsa — eng yangi summa bilan tasdiqlaymiz.
  await requote()
  const q = quote.value
  if (!q || error.value) return
  if (!q.shiftOpen) { error.value = t('returns.shiftClosed'); return }
  if (selected.value.length === 0) { error.value = t('returns.nothingSelected'); return }
  const ok = await confirmDialog(t('returns.confirm', { amount: moneySum(q.amount) }), { title: t('returns.confirmTitle'), danger: true })
  if (!ok) return
  busy.value = true
  try {
    const bal = clampBalance(refundBalance.value)
    const money = q.amount - bal
    const r = await createReturn({
      saleId: props.saleId,
      lines: selected.value,
      refundCash: method.value === 'cash' ? money : 0,
      refundCard: method.value === 'card' ? money : 0,
      refundBalance: bal,
      reason: reason.value.trim() || null,
    })
    created.value = r
    notify(t('returns.done', { number: r.returnNumber }), 'success')
    emit('done', r)
  } catch (e) {
    error.value = returnErrorMessage(e)
    // Holat o'zgargan bo'lishi mumkin (parallel vozvrat, smena yopilgan) — yangilab ko'rsatamiz.
    const msg = error.value
    await requote()
    error.value = msg
  } finally {
    busy.value = false
  }
}

function print() {
  if (created.value) void printReturnReceipt(createdToReceipt(created.value, props.customerLabel))
}
</script>

<template>
  <!-- Tepaga mahkamlangan (markazda emas): miqdor tanlanganda oyna pastga o'sadi, qatorlar
       kursor ostidan siljimaydi — aks holda keyingi bosish boshqa tovarga tushadi. -->
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-3 sm:p-4 sm:pt-[6vh]">
    <div class="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-card shadow-xl sm:max-h-[88vh]">
      <div class="flex items-center gap-2 border-b px-4 py-3 sm:px-5">
        <RotateCcw class="h-4.5 w-4.5 shrink-0 text-amber-600" />
        <div class="min-w-0 flex-1">
          <div class="truncate font-semibold">{{ $t('returns.title') }} · {{ $t('pos.receiptNumber', { number: quote?.receiptNumber ?? '…' }) }}</div>
          <div class="truncate text-xs text-muted-foreground">{{ customerLabel }}</div>
        </div>
      </div>

      <!-- Bajarildi -->
      <div v-if="created" class="space-y-4 p-5 text-center">
        <CheckCircle2 class="mx-auto h-10 w-10 text-emerald-600" />
        <div>
          <div class="text-lg font-semibold">{{ $t('returns.done', { number: created.returnNumber }) }}</div>
          <div class="mt-1 text-2xl font-bold tabular-nums">{{ moneySum(created.amount) }}</div>
        </div>
        <div class="mx-auto max-w-xs space-y-1 rounded-lg bg-muted/40 p-3 text-sm">
          <div v-if="created.refundCash > 0" class="flex justify-between"><span class="text-muted-foreground">{{ $t('returns.refundCash') }}</span><span class="tabular-nums">{{ moneySum(created.refundCash) }}</span></div>
          <div v-if="created.refundCard > 0" class="flex justify-between"><span class="text-muted-foreground">{{ $t('returns.refundCard') }}</span><span class="tabular-nums">{{ moneySum(created.refundCard) }}</span></div>
          <div v-if="created.refundBalance > 0" class="flex justify-between"><span class="text-muted-foreground">{{ $t('returns.refundBalance') }}</span><span class="tabular-nums">{{ moneySum(created.refundBalance) }}</span></div>
        </div>
        <div class="flex gap-2">
          <button @click="print" class="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md border text-sm font-medium hover:bg-muted"><Printer class="h-4 w-4" /> {{ $t('returns.printReceipt') }}</button>
          <button @click="emit('close')" class="h-10 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">{{ $t('common.close') }}</button>
        </div>
      </div>

      <template v-else>
        <div class="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          <div v-if="loading" class="py-10 text-center text-sm text-muted-foreground">…</div>
          <template v-else-if="quote">
            <div v-if="!quote.shiftOpen" class="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" /> {{ $t('returns.shiftClosed') }}
            </div>

            <!-- Tovarlar -->
            <div class="overflow-hidden rounded-lg border">
              <div class="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
                <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('sales.product') }}</span>
                <div class="flex gap-1.5">
                  <button @click="selectAll" :disabled="!anyReturnable" class="rounded-md border bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40">{{ $t('returns.selectAll') }}</button>
                  <button v-if="selected.length" @click="clearAll" class="rounded-md border bg-card px-2.5 py-1 text-xs hover:bg-muted">{{ $t('returns.clearAll') }}</button>
                </div>
              </div>
              <ul class="divide-y">
                <li v-for="l in lines" :key="l.saleItemId" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5" :class="l.qtyRemaining <= 1e-6 ? 'opacity-50' : ''">
                  <div class="min-w-0 flex-1 basis-48">
                    <div class="truncate text-sm font-medium">{{ l.productName }}</div>
                    <div class="text-xs text-muted-foreground tabular-nums">
                      {{ $t('returns.colSold') }} {{ fmtQty(l.qtySold) }} {{ l.unit }} × {{ moneySum(l.price) }}
                      <template v-if="l.qtyReturned > 0"> · <span class="text-amber-600">{{ $t('returns.colReturned') }} {{ fmtQty(l.qtyReturned) }}</span></template>
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <input
                      type="number" min="0" :max="l.qtyRemaining" :step="isIntegerUnit(l) ? 1 : 0.001"
                      :value="qty[l.saleItemId] ?? 0" :disabled="l.qtyRemaining <= 1e-6"
                      @change="setQty(l.saleItemId, ($event.target as HTMLInputElement).value, l.qtyRemaining)"
                      @input="onQtyInput(l.saleItemId, ($event.target as HTMLInputElement).value, l.qtyRemaining)"
                      class="h-9 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums disabled:opacity-50"
                    />
                    <span class="w-14 text-xs text-muted-foreground">/ {{ fmtQty(l.qtyRemaining) }} {{ l.unit }}</span>
                    <button @click="setQty(l.saleItemId, l.qtyRemaining, l.qtyRemaining)" :disabled="l.qtyRemaining <= 1e-6" class="h-9 rounded-md border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-40">{{ $t('returns.all') }}</button>
                  </div>
                </li>
              </ul>
            </div>

            <!-- Summa va taqsimot -->
            <div class="space-y-3 rounded-lg border p-3">
              <div class="flex items-baseline justify-between">
                <span class="text-sm text-muted-foreground">{{ $t('returns.amount') }}</span>
                <span class="text-2xl font-bold tabular-nums">{{ moneySum(amount) }}</span>
              </div>
              <div v-if="quote.alreadyRefunded > 0" class="text-right text-xs text-muted-foreground">{{ $t('returns.alreadyRefunded', { amount: moneySum(quote.alreadyRefunded) }) }}</div>

              <RefundSplit :amount="amount" :money-cap="quote.moneyCap" :balance-allowed="quote.balanceAllowed" :customer-balance="quote.customerBalance"
                :balance="refundBalance" @update:balance="onBalance" v-model:method="method" />
            </div>

            <div>
              <label class="mb-1 block text-sm font-medium">{{ $t('returns.reason') }}</label>
              <textarea v-model="reason" maxlength="500" rows="2" :placeholder="$t('returns.reasonPlaceholder')" class="w-full rounded-md border bg-background px-3 py-2 text-sm"></textarea>
            </div>
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
