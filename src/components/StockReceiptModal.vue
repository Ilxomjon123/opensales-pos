<script setup lang="ts">
// Yangi kirim (prixod): ta'minotchi, sana, tovar qatorlari (miqdor, kirim narxi, ixtiyoriy
// yangi sotuv narxi). Qoldiq/tannarx/narxni Rust bitta tranzaksiyada yozadi (stock.rs).
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PackagePlus, X, Barcode } from 'lucide-vue-next'
import { listProducts, findProductByBarcode, dayIso, type Product } from '../lib/db'
import { createStockReceipt, receiptSuppliers, stockErrorMessage, type CreatedReceipt } from '../lib/stock'
import { moneySum } from '../lib/format'
import { fmtQty } from '../lib/returns'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'
import { beepOk, beepFail } from '../lib/beep'
import SearchableSelect from './SearchableSelect.vue'
import QrScanButton from './QrScanButton.vue'

const emit = defineEmits<{ close: []; done: [r: CreatedReceipt] }>()
const { t } = useI18n()

type Line = { productId: number; name: string; unit: string; stock: number; oldCost: number; oldPrice: number; qty: number; cost: number; salePrice: number }

const today = new Date().toISOString().slice(0, 10)
const products = ref<Product[]>([])
const suppliers = ref<string[]>([])
const supplier = ref('')
const date = ref(today)
const note = ref('')
const lines = ref<Line[]>([])
const picker = ref<number | null>(null)
const code = ref('')
const busy = ref(false)
const error = ref('')

onMounted(async () => {
  ;[products.value, suppliers.value] = await Promise.all([listProducts(true), receiptSuppliers()])
})

const pickerItems = computed(() => products.value.map((p) => ({
  value: p.id,
  label: `${p.name} · ${fmtQty(p.stock)} ${p.unit}${p.barcode ? ` · ${p.barcode}` : ''}`,
})))

// Bir mahsulot ikki qator bo'lmaydi — qayta tanlansa miqdori +1.
function addProduct(p: Product) {
  error.value = ''
  const ex = lines.value.find((l) => l.productId === p.id)
  if (ex) { ex.qty = Math.round((ex.qty + 1) * 1000) / 1000; return }
  lines.value.push({
    productId: p.id, name: p.name, unit: p.unit, stock: p.stock,
    oldCost: Math.round(p.cost_price), oldPrice: Math.round(p.price),
    qty: 1, cost: Math.round(p.cost_price), salePrice: Math.round(p.price),
  })
}
watch(picker, (id) => {
  if (id == null) return
  const p = products.value.find((x) => x.id === Number(id))
  if (p) addProduct(p)
  picker.value = null
})

async function addByCode(raw: string) {
  const c = raw.trim()
  if (!c) return
  const p = await findProductByBarcode(c)
  if (!p) { beepFail(); notify(t('pos.codeNotFound', { code: c }), 'error'); return }
  beepOk()
  addProduct(p)
}
// Avval tozalanadi, keyin qidiriladi: skaner keyingi kodni qidiruv tugamasdan yozib qo'ysa,
// u o'chib ketmasin.
async function onCodeEnter() { const c = code.value; code.value = ''; await addByCode(c) }

// USB shtrix skaner (keyboard-wedge) — hech qaysi maydon fokusda bo'lmasa ham ishlaydi.
let scanBuf = ''
let lastKey = 0
function onGlobalKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  const now = Date.now()
  if (now - lastKey > 100) scanBuf = ''
  lastKey = now
  if (e.key === 'Enter') {
    if (scanBuf.length >= 3) { e.preventDefault(); void addByCode(scanBuf) }
    scanBuf = ''
  } else if (e.key.length === 1) {
    scanBuf += e.key
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))

function removeLine(l: Line) { lines.value = lines.value.filter((x) => x !== l) }
const lineTotal = (l: Line) => Math.round((l.qty || 0) * (l.cost || 0))
const priceChanged = (l: Line) => Number.isFinite(l.salePrice) && Math.round(l.salePrice) !== l.oldPrice
const total = computed(() => lines.value.reduce((s, l) => s + lineTotal(l), 0))
const okNum = (v: number, min: number) => Number.isFinite(v) && v >= min
const lineValid = (l: Line) => okNum(l.qty, 0.001) && okNum(l.cost, 0) && okNum(l.salePrice, 0)
const canSubmit = computed(() => lines.value.length > 0 && lines.value.every(lineValid) && !busy.value && !!date.value && date.value <= today)

async function submit() {
  if (!canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    const r = await createStockReceipt({
      supplier: supplier.value.trim() || null,
      note: note.value.trim() || null,
      receivedAt: dayIso(date.value),
      lines: lines.value.map((l) => ({
        productId: l.productId,
        qty: l.qty,
        costPrice: l.cost,
        salePrice: priceChanged(l) ? l.salePrice : null,
      })),
    })
    notify(t('stock.created', { number: r.receiptNumber, total: moneySum(r.total) }), 'success')
    emit('done', r)
    emit('close')
  } catch (e) {
    error.value = stockErrorMessage(e)
  } finally {
    busy.value = false
  }
}

async function close() {
  if (lines.value.length && !(await confirmDialog(t('stock.discardConfirm'), { danger: true, cancelText: t('common.no') }))) return
  emit('close')
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-3 sm:p-4 sm:pt-[5vh]">
    <div class="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border bg-card shadow-xl sm:max-h-[90vh]">
      <div class="flex items-center gap-2 border-b px-4 py-3 sm:px-5">
        <PackagePlus class="h-4.5 w-4.5 shrink-0 text-emerald-600" />
        <div class="min-w-0 flex-1 font-semibold">{{ $t('stock.newReceipt') }}</div>
        <button @click="close" class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"><X class="h-4 w-4" /></button>
      </div>

      <div class="min-h-[22rem] flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
        <div class="grid gap-3 sm:grid-cols-[1fr_11rem]">
          <div>
            <label class="mb-1 block text-sm font-medium">{{ $t('stock.supplier') }}</label>
            <input v-model="supplier" list="stock-suppliers" maxlength="120" :placeholder="$t('stock.supplierPlaceholder')" class="h-10 w-full rounded-md border bg-background px-3 text-sm" />
            <datalist id="stock-suppliers"><option v-for="s in suppliers" :key="s" :value="s" /></datalist>
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium">{{ $t('stock.date') }}</label>
            <input v-model="date" type="date" :max="today" class="h-10 w-full rounded-md border bg-background px-3 text-sm" />
          </div>
        </div>

        <!-- Tovar qo'shish: ro'yxatdan, shtrix kod yozib/skanerlab yoki kamera bilan -->
        <div class="flex flex-col gap-2 sm:flex-row">
          <div class="min-w-0 flex-1"><SearchableSelect v-model="picker" :items="pickerItems" :placeholder="$t('stock.addProduct')" :search-placeholder="$t('stock.productSearch')" /></div>
          <div class="flex gap-2 sm:w-64">
            <div class="relative min-w-0 flex-1">
              <Barcode class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input v-model="code" @keyup.enter="onCodeEnter" :placeholder="$t('stock.barcodePlaceholder')" class="h-10 w-full rounded-md border bg-background pr-2 pl-9 text-sm" />
            </div>
            <QrScanButton @decoded="(c) => addByCode(c)" />
          </div>
        </div>

        <div v-if="lines.length === 0" class="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{{ $t('stock.noLines') }}</div>
        <!-- Qat'iy ustunli grid: uzun nom qisqartiriladi, raqam ustunlari va o'chirish tugmasi
             doim ko'rinadi (jadvalda nom ustunni cho'zib, qolganini oynadan chiqarib yuborardi).
             lg dan kichikda — nom tepada, maydonlar ostida yorliqlari bilan. -->
        <div v-else class="overflow-hidden rounded-lg border text-sm">
          <div class="hidden grid-cols-[minmax(0,1fr)_7rem_7.5rem_7.5rem_7.5rem_2rem] items-center gap-2 bg-muted px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase lg:grid">
            <div>{{ $t('stock.colProduct') }}</div>
            <div class="text-right">{{ $t('stock.colQty') }}</div>
            <div class="text-right">{{ $t('stock.colCost') }}</div>
            <div class="text-right">{{ $t('stock.colSalePrice') }}</div>
            <div class="text-right">{{ $t('stock.colSum') }}</div>
            <div></div>
          </div>
          <div class="divide-y">
            <div v-for="l in lines" :key="l.productId"
              class="grid grid-cols-2 items-end gap-x-2 gap-y-2 px-3 py-2.5 sm:grid-cols-4 lg:grid-cols-[minmax(0,1fr)_7rem_7.5rem_7.5rem_7.5rem_2rem] lg:items-center">
              <div class="col-span-2 flex min-w-0 items-start gap-2 sm:col-span-4 lg:col-span-1">
                <div class="min-w-0 flex-1">
                  <div class="truncate font-medium" :title="l.name">{{ l.name }}</div>
                  <div class="truncate text-xs text-muted-foreground tabular-nums">{{ $t('stock.currentStock', { qty: fmtQty(l.stock), unit: l.unit }) }} · {{ $t('stock.currentCost', { cost: moneySum(l.oldCost) }) }}</div>
                  <div v-if="priceChanged(l)" class="truncate text-xs text-amber-600 tabular-nums">{{ $t('stock.priceChange', { from: moneySum(l.oldPrice), to: moneySum(l.salePrice) }) }}</div>
                </div>
                <button @click="removeLine(l)" :title="$t('common.delete')" class="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 lg:hidden"><X class="h-4 w-4" /></button>
              </div>
              <label class="block min-w-0">
                <span class="mb-0.5 block text-[11px] text-muted-foreground lg:hidden">{{ $t('stock.colQty') }}</span>
                <span class="relative block">
                  <input v-model.number="l.qty" type="number" min="0" step="any" class="h-9 w-full rounded-md border bg-background pr-11 pl-2 text-right tabular-nums" :class="okNum(l.qty, 0.001) ? '' : 'border-rose-500'" />
                  <span class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">{{ l.unit }}</span>
                </span>
              </label>
              <label class="block min-w-0">
                <span class="mb-0.5 block text-[11px] text-muted-foreground lg:hidden">{{ $t('stock.colCost') }}</span>
                <input v-model.number="l.cost" type="number" min="0" class="h-9 w-full rounded-md border bg-background px-2 text-right tabular-nums" :class="okNum(l.cost, 0) ? '' : 'border-rose-500'" />
              </label>
              <label class="block min-w-0">
                <span class="mb-0.5 block text-[11px] text-muted-foreground lg:hidden">{{ $t('stock.colSalePrice') }}</span>
                <input v-model.number="l.salePrice" type="number" min="0" class="h-9 w-full rounded-md border bg-background px-2 text-right tabular-nums"
                  :class="!okNum(l.salePrice, 0) ? 'border-rose-500' : priceChanged(l) ? 'border-amber-500 bg-amber-500/5' : ''" />
              </label>
              <div class="min-w-0 text-right">
                <span class="mb-0.5 block text-[11px] text-muted-foreground lg:hidden">{{ $t('stock.colSum') }}</span>
                <div class="flex h-9 items-center justify-end truncate font-semibold tabular-nums">{{ moneySum(lineTotal(l)) }}</div>
              </div>
              <button @click="removeLine(l)" :title="$t('common.delete')" class="hidden h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 lg:flex"><X class="h-4 w-4" /></button>
            </div>
          </div>
        </div>
        <p v-if="lines.length" class="text-xs text-muted-foreground">{{ $t('stock.costHint') }}</p>

        <div>
          <label class="mb-1 block text-sm font-medium">{{ $t('stock.note') }}</label>
          <textarea v-model="note" maxlength="500" rows="2" class="w-full rounded-md border bg-background px-3 py-2 text-sm"></textarea>
        </div>

        <div v-if="error" class="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-600">{{ error }}</div>
      </div>

      <div class="flex flex-wrap items-center gap-2 border-t px-4 py-3 sm:px-5">
        <div class="w-full text-sm sm:mr-auto sm:w-auto">
          <span class="text-muted-foreground">{{ $t('stock.linesCount', { count: lines.length }) }} · </span>
          <span class="text-lg font-bold tabular-nums">{{ moneySum(total) }}</span>
        </div>
        <button @click="close" :disabled="busy" class="h-10 flex-1 rounded-md border px-4 text-sm hover:bg-muted disabled:opacity-50 sm:flex-none">{{ $t('common.cancel') }}</button>
        <button @click="submit" :disabled="!canSubmit" class="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 text-sm font-semibold whitespace-nowrap sm:px-5 text-white hover:bg-emerald-700 disabled:opacity-50 sm:flex-none">
          <PackagePlus class="h-4 w-4" /> {{ $t('stock.save') }}
        </button>
      </div>
    </div>
  </div>
</template>
