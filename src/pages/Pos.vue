<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { Search, Plus, Minus, Trash2, Package, ShoppingCart, X, ClipboardList, LogOut, Magnet, ChevronUp, History } from 'lucide-vue-next'
import {
  listProducts, listCategories, listCustomers, activeShift, openShift, closeShift,
  shiftStats, createSale, getSetting, productCustomerHistory,
  type Product, type Category, type Customer, type Shift, type CartLine, type ProductCustomerHistoryRow,
} from '../lib/db'
import { money, moneySum, currencySymbol, translitMatch, formatDateTime } from '../lib/format'
import SearchableSelect from '../components/SearchableSelect.vue'
import { printReceipt } from '../lib/print'

const products = ref<Product[]>([])
const categories = ref<Category[]>([])
const customers = ref<Customer[]>([])
const shift = ref<Shift | null>(null)
const stats = ref({ sales_count: 0, total_sales: 0 })
const allowNegative = ref(false)
const keepCart = ref(false)

const search = ref('')
const activeCat = ref<number | null>(null)
const cart = ref<CartLine[]>([])
const customerId = ref<number>(0)
const discount = ref(0)
const paidCash = ref(0)
const paidCard = ref(0)
const submitting = ref(false)
const toast = ref('')
// Mobil: savat pastdan ko'tariladigan sheet sifatida ochiladi.
const cartOpen = ref(false)

// Shu mahsulot tanlangan mijozga oldin necha puldan / nechta sotilgani.
// product_id -> tarix qatorlari (eng yangisi birinchi). Mijoz yoki savat o'zgarsa qayta yuklanadi.
const histories = ref<Record<number, ProductCustomerHistoryRow[]>>({})
async function loadHistory(productId: number) {
  if (!customerId.value) { histories.value[productId] = []; return }
  histories.value[productId] = await productCustomerHistory(productId, customerId.value)
}
function lastSold(productId: number): ProductCustomerHistoryRow | null {
  return histories.value[productId]?.[0] ?? null
}
// Mijoz almashsa — barcha savat qatorlari uchun qayta yukla.
watch(customerId, () => { cart.value.forEach((l) => loadHistory(l.product_id)) })

// Tarix modali
const histModal = ref<{ name: string; productId: number } | null>(null)
const histRows = computed(() => (histModal.value ? histories.value[histModal.value.productId] ?? [] : []))
const histTotalQty = computed(() => histRows.value.reduce((s, r) => s + r.qty, 0))
const histTotalSum = computed(() => histRows.value.reduce((s, r) => s + r.subtotal, 0))
function openHistory(l: CartLine) { histModal.value = { name: l.name, productId: l.product_id } }

// Savat paneli kengligi (resize)
const clampW = (w: number) => Math.min(640, Math.max(300, w))
const cartW = ref(clampW(Number(localStorage.getItem('pos_cart_w')) || 400))
const dragging = ref(false)
function startDrag(e: PointerEvent) {
  e.preventDefault()
  dragging.value = true
  const move = (ev: PointerEvent) => { cartW.value = clampW(window.innerWidth - ev.clientX) }
  const up = () => {
    dragging.value = false
    localStorage.setItem('pos_cart_w', String(cartW.value))
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// Input kengligi raqam uzunligiga qarab
function numW(v: number | null, min: number) {
  const len = String(v ?? '').length
  return Math.max(min, len * 11 + 28) + 'px'
}

type Receipt = {
  receipt_number: string
  created_at: string
  customer: string
  items: { name: string; qty: number; unit: string; price: number; subtotal: number }[]
  subtotal: number
  discount: number
  total: number
  paid_cash: number
  paid_card: number
  change: number
  debt: number
}
const receipt = ref<Receipt | null>(null)

const openCashInput = ref(0)
const closeCashInput = ref(0)
const showClose = ref(false)

async function reload() {
  ;[products.value, categories.value, customers.value, shift.value] = await Promise.all([
    listProducts(), listCategories(), listCustomers(true), activeShift(),
  ])
  customerId.value = customers.value.find((c) => c.is_walk_in)?.id ?? customers.value[0]?.id ?? 0
  allowNegative.value = (await getSetting('allow_negative_stock', '0')) === '1'
  keepCart.value = (await getSetting('keep_cart', '0')) === '1'
  if (shift.value) stats.value = await shiftStats(shift.value.id)
  restoreCart()
}
onMounted(reload)

// --- Savatni saqlash (sozlama: keep_cart) ---
const CART_KEY = 'pos_saved_cart'
const CART_CUST_KEY = 'pos_saved_cart_customer'
let restoring = false
// Boshqa bo'limdan qaytganda saqlangan savatni tiklash. Mahsulot/qoldiq joriy holatga moslanadi,
// o'chirilgan mahsulot tushib qoladi. Smena yopiq bo'lsa tiklanmaydi.
function restoreCart() {
  if (!keepCart.value || !shift.value) return
  restoring = true
  try {
    const raw = localStorage.getItem(CART_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as CartLine[]
      cart.value = saved
        .map((s) => {
          const p = products.value.find((x) => x.id === s.product_id)
          return p ? { ...s, name: p.name, unit: p.unit, cost_price: p.cost_price, stock: p.stock } : null
        })
        .filter((l): l is CartLine => l !== null)
    }
    const cust = Number(localStorage.getItem(CART_CUST_KEY))
    if (cust && customers.value.some((c) => c.id === cust)) customerId.value = cust
    cart.value.forEach((l) => loadHistory(l.product_id))
  } catch { /* buzilgan saqlash — e'tiborsiz */ }
  finally { restoring = false }
}
function persistCart() {
  if (restoring || !keepCart.value) return
  if (cart.value.length === 0) { localStorage.removeItem(CART_KEY); localStorage.removeItem(CART_CUST_KEY); return }
  localStorage.setItem(CART_KEY, JSON.stringify(cart.value))
  localStorage.setItem(CART_CUST_KEY, String(customerId.value))
}
watch([cart, customerId], persistCart, { deep: true })

const filtered = computed(() => {
  let list = products.value
  // Ostatkasiz sotish o'chiq bo'lsa — qoldig'i 0 mahsulot umuman ko'rinmaydi.
  if (!allowNegative.value) list = list.filter((p) => p.stock > 0)
  if (activeCat.value) list = list.filter((p) => p.category_id === activeCat.value)
  if (search.value.trim()) list = list.filter((p) => translitMatch(p.name, search.value))
  return list
})

const customerItems = computed(() => customers.value.map((c) => ({ value: c.id, label: c.phone ? `${c.name} · ${c.phone}` : c.name })))
const selectedCustomer = computed(() => customers.value.find((c) => c.id === customerId.value) ?? null)
const subtotal = computed(() => cart.value.reduce((s, it) => s + Math.round(it.qty * it.price), 0))
const total = computed(() => Math.max(0, subtotal.value - (discount.value || 0)))
const paid = computed(() => (paidCash.value || 0) + (paidCard.value || 0))
const debt = computed(() => Math.max(0, total.value - paid.value))
const change = computed(() => Math.max(0, paid.value - total.value))
const debtBlocked = computed(() => debt.value > 0 && selectedCustomer.value?.is_walk_in)
const canSubmit = computed(() => cart.value.length > 0 && !debtBlocked.value && !!shift.value)
// Mijozning joriy saldosi. Manfiy = qarzdor. Bu sotuv qarzi saldoni kamaytiradi (ortiqcha to'lov qaytim, saldoga yozilmaydi).
const curBalance = computed(() => (selectedCustomer.value && !selectedCustomer.value.is_walk_in ? selectedCustomer.value.balance : 0))
const balanceAfter = computed(() => curBalance.value - debt.value)

function addProduct(p: Product) {
  if (!allowNegative.value && p.stock <= 0) return
  const line = cart.value.find((l) => l.product_id === p.id)
  if (line) {
    if (allowNegative.value || line.qty < p.stock) line.qty++
  } else {
    cart.value.push({ product_id: p.id, name: p.name, unit: p.unit, price: p.price, cost_price: p.cost_price, qty: 1, stock: p.stock })
    loadHistory(p.id)
  }
}
function inc(l: CartLine) { if (allowNegative.value || l.qty < l.stock) l.qty++ }
function dec(l: CartLine) { l.qty--; if (l.qty <= 0) removeLine(l) }
function removeLine(l: CartLine) { cart.value = cart.value.filter((x) => x !== l) }
function clearCart() { cart.value = []; discount.value = 0; paidCash.value = 0; paidCard.value = 0 }
function normalizePrice(l: CartLine) { if (!Number.isFinite(l.price) || l.price < 0) l.price = 0 }
function lineTotal(l: CartLine) { return Math.round(l.qty * l.price) }

const quickCash = computed(() => {
  const t = total.value
  const base = [t]
  ;[1000, 5000, 10000, 50000].forEach((step) => base.push(Math.ceil(t / step) * step + step))
  return [...new Set(base.filter((x) => x > 0))].slice(0, 4)
})
function setExact() { paidCash.value = Math.max(0, total.value - (paidCard.value || 0)) }

async function submit() {
  if (!canSubmit.value || submitting.value || !shift.value) return
  submitting.value = true
  try {
    const items = cart.value.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, price: l.price, subtotal: lineTotal(l) }))
    const sale = await createSale({
      shiftId: shift.value.id,
      customerId: customerId.value,
      items: cart.value,
      paidCash: paidCash.value || 0,
      paidCard: paidCard.value || 0,
      discount: discount.value || 0,
    })
    receipt.value = {
      receipt_number: sale.receipt_number,
      created_at: sale.created_at,
      customer: selectedCustomer.value?.name ?? '—',
      items,
      subtotal: subtotal.value,
      discount: discount.value || 0,
      total: sale.total,
      paid_cash: sale.paid_cash,
      paid_card: sale.paid_card,
      change: change.value,
      debt: sale.debt_amount,
    }
    clearCart()
    cartOpen.value = false
    await reload()
  } catch (e: any) {
    toast.value = e?.message ?? 'Xato'
    setTimeout(() => (toast.value = ''), 3000)
  } finally {
    submitting.value = false
  }
}

function doPrint() { if (receipt.value) printReceipt(receipt.value) }

async function doOpenShift() {
  shift.value = await openShift(openCashInput.value || 0)
  stats.value = await shiftStats(shift.value.id)
}
async function doCloseShift() {
  if (!shift.value) return
  await closeShift(shift.value.id, closeCashInput.value || 0)
  shift.value = null
  showClose.value = false
  cart.value = []
}
</script>

<template>
  <!-- Smena yo'q — ochish to'sig'i -->
  <div v-if="!shift" class="flex h-full items-center justify-center p-6">
    <div class="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm">
      <div class="mb-4 flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ClipboardList class="h-5 w-5" />
        </div>
        <div>
          <div class="text-lg font-semibold">Smena ochilmagan</div>
          <div class="text-sm text-muted-foreground">Sotuvni boshlash uchun smenani oching</div>
        </div>
      </div>
      <label class="mb-1 block text-sm font-medium">Boshlang'ich naqd ({{ currencySymbol }})</label>
      <input v-model.number="openCashInput" type="number" min="0"
        class="mb-4 h-10 w-full rounded-md border bg-background px-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
      <button @click="doOpenShift"
        class="h-10 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">
        Smenani ochish
      </button>
    </div>
  </div>

  <!-- Terminal -->
  <div v-else class="flex h-full" :class="dragging ? 'select-none' : ''">
    <!-- Chap: mahsulotlar -->
    <div class="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4 pt-[calc(env(safe-area-inset-top)+1rem)] lg:pt-4">
      <div class="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-2.5 sm:gap-3 sm:p-3">
        <div class="flex items-center gap-2 text-sm">
          <div class="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
            <ClipboardList class="h-4 w-4" />
          </div>
          <div>
            <div class="font-medium">Smena #{{ shift.id }}</div>
            <div class="text-xs text-muted-foreground">{{ stats.sales_count }} ta · {{ moneySum(stats.total_sales) }}</div>
          </div>
        </div>
        <button @click="showClose = true"
          class="order-2 ml-auto flex h-9 items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted sm:order-3">
          <LogOut class="h-4 w-4" /> <span class="hidden sm:inline">Smenani yopish</span>
        </button>
        <div class="relative order-3 w-full sm:order-2 sm:ml-auto sm:w-56 lg:w-72">
          <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input v-model="search" placeholder="Mahsulot qidirish…"
            class="h-9 w-full rounded-md border bg-background pl-9 pr-2 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
        </div>
      </div>

      <!-- Kategoriya tablar -->
      <div class="flex gap-2 overflow-x-auto pb-1">
        <button @click="activeCat = null"
          class="shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium"
          :class="activeCat === null ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'">
          Barchasi
        </button>
        <button v-for="c in categories" :key="c.id" @click="activeCat = c.id"
          class="shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium"
          :class="activeCat === c.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'">
          {{ c.name }}
        </button>
      </div>

      <!-- Grid -->
      <div class="grid flex-1 auto-rows-max grid-cols-[repeat(auto-fill,minmax(140px,1fr))] items-start gap-2.5 overflow-y-auto pb-20 sm:gap-3 lg:pb-0">
        <button v-for="p in filtered" :key="p.id" type="button" :disabled="!allowNegative && p.stock <= 0" @click="addProduct(p)"
          class="group flex flex-col overflow-hidden rounded-xl border bg-card text-left transition hover:border-primary/40 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50">
          <div class="relative h-28 w-full shrink-0 bg-muted">
            <img v-if="p.image" :src="p.image" class="h-full w-full object-cover" />
            <div v-else class="flex h-full w-full items-center justify-center text-muted-foreground"><Package class="h-10 w-10" /></div>
            <div v-if="p.stock <= 0" class="absolute inset-0 flex items-center justify-center bg-rose-500/85 text-sm font-semibold text-white">Tugadi</div>
          </div>
          <div class="flex flex-col gap-0.5 p-2.5">
            <div class="line-clamp-2 min-h-[2.2rem] text-sm font-medium leading-tight">{{ p.name }}</div>
            <div class="truncate text-base font-semibold leading-tight">{{ moneySum(p.price) }}</div>
            <div class="text-xs text-muted-foreground">{{ p.stock }} {{ p.unit }}</div>
          </div>
        </button>
        <div v-if="filtered.length === 0" class="col-span-full rounded-xl border border-dashed bg-muted/30 p-12 text-center text-muted-foreground">Mahsulot topilmadi</div>
      </div>
    </div>

    <!-- Resize handle (faqat desktop) -->
    <div @pointerdown="startDrag" class="group/handle relative hidden w-1 shrink-0 cursor-col-resize bg-border transition hover:bg-primary/60 lg:block" :class="dragging ? 'bg-primary' : ''">
      <div class="absolute inset-y-0 -left-1.5 -right-1.5"></div>
    </div>

    <!-- Mobil savat backdrop -->
    <div v-if="cartOpen" class="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden" @click="cartOpen = false"></div>

    <!-- O'ng: savat. Desktop'da yon panel, mobil'da pastdan ko'tariladigan sheet. -->
    <aside
      :style="{ '--cart-w': cartW + 'px' }"
      class="fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-2xl border-t bg-card shadow-2xl transition-transform duration-300 lg:static lg:z-auto lg:max-h-none lg:w-[var(--cart-w)] lg:translate-y-0 lg:rounded-none lg:border-t-0 lg:border-l lg:shadow-none"
      :class="cartOpen ? 'translate-y-0' : 'translate-y-full lg:translate-y-0'"
    >
      <!-- Mobil sheet sarlavhasi -->
      <div class="flex shrink-0 items-center justify-between border-b px-4 py-2.5 lg:hidden">
        <div class="flex items-center gap-2 text-sm font-semibold"><ShoppingCart class="h-4 w-4" /> Savat · {{ cart.length }}</div>
        <button @click="cartOpen = false" class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"><X class="h-4 w-4" /></button>
      </div>
      <!-- Mijoz -->
      <div class="shrink-0 space-y-2 border-b p-4">
        <span class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Mijoz</span>
        <SearchableSelect v-model="customerId" :items="customerItems" placeholder="Mijozni tanlang" search-placeholder="Ism yoki telefon…" />
        <div v-if="selectedCustomer && !selectedCustomer.is_walk_in" class="flex items-center justify-between text-xs">
          <span class="text-muted-foreground">Joriy saldo</span>
          <span class="font-semibold tabular-nums"
            :class="selectedCustomer.balance < 0 ? 'text-rose-600' : selectedCustomer.balance > 0 ? 'text-emerald-600' : 'text-muted-foreground'">
            {{ moneySum(Math.abs(selectedCustomer.balance)) }}
            <span class="font-normal text-muted-foreground">{{ selectedCustomer.balance < 0 ? '· qarzdor' : selectedCustomer.balance > 0 ? '· haqdor' : '' }}</span>
          </span>
        </div>
      </div>

      <!-- Savat header -->
      <div class="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
        <span class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Savat</span>
        <div class="flex items-center gap-2">
          <span class="text-xs text-muted-foreground">{{ cart.length }} ta</span>
          <button v-if="cart.length" @click="clearCart" class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive">
            <X class="h-3 w-3" /> Tozalash
          </button>
        </div>
      </div>

      <!-- Savat ro'yxati -->
      <div class="min-h-0 flex-1 overflow-auto">
        <div v-if="cart.length === 0" class="flex flex-col items-center px-4 py-12 text-center text-muted-foreground">
          <div class="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-muted"><ShoppingCart class="h-7 w-7 opacity-50" /></div>
          <div class="text-sm font-medium">Savat bo'sh</div>
        </div>
        <ul v-else class="divide-y">
          <li v-for="l in cart" :key="l.product_id" class="group px-3 py-1.5 hover:bg-muted/40">
            <div class="flex items-center gap-2">
              <div class="line-clamp-1 min-w-0 flex-1 text-[13px] font-medium leading-tight">{{ l.name }}</div>
              <button @click="removeLine(l)" class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-rose-500/10 hover:text-rose-600"><Trash2 class="h-3.5 w-3.5" /></button>
            </div>
            <div class="mt-1 flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input v-model.number="l.price" type="number" min="0" @blur="normalizePrice(l)" :style="{ width: numW(l.price, 84) }"
                    class="h-8 rounded-md border bg-background px-2 text-sm text-foreground tabular-nums [appearance:textfield] focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                  <span>{{ currencySymbol }} /{{ l.unit }}</span>
                </div>
                <button v-if="lastSold(l.product_id)" type="button" @click="openHistory(l)"
                  class="mt-1 flex items-center gap-1 text-left text-[11px] leading-tight text-muted-foreground hover:text-primary">
                  <History class="h-3 w-3 shrink-0" /> oxirgi: {{ moneySum(lastSold(l.product_id)!.price) }}
                </button>
              </div>
              <div class="flex shrink-0 flex-col items-center gap-1">
                <div class="inline-flex items-center rounded-md border bg-background">
                  <button @click="dec(l)" class="flex h-8 w-8 items-center justify-center text-muted-foreground hover:bg-muted"><Minus class="h-3.5 w-3.5" /></button>
                  <input v-model.number="l.qty" type="number" min="0" :max="l.stock" :style="{ width: numW(l.qty, 44) }" class="h-8 border-0 bg-transparent px-0 text-center text-sm tabular-nums [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                  <button @click="inc(l)" class="flex h-8 w-8 items-center justify-center text-muted-foreground hover:bg-muted"><Plus class="h-3.5 w-3.5" /></button>
                </div>
                <button v-if="lastSold(l.product_id)" type="button" @click="openHistory(l)"
                  class="whitespace-nowrap text-[11px] leading-tight text-muted-foreground hover:text-primary">
                  {{ lastSold(l.product_id)!.qty }} {{ l.unit }}
                </button>
              </div>
              <div class="flex h-8 shrink-0 items-center justify-end whitespace-nowrap pl-1 text-right text-[13px] font-semibold tabular-nums">{{ moneySum(lineTotal(l)) }}</div>
            </div>
          </li>
        </ul>
      </div>

      <!-- To'lov -->
      <div class="shrink-0 space-y-3 border-t p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] lg:pb-4">
        <div class="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
          <span class="text-sm font-medium text-muted-foreground">JAMI</span>
          <span class="text-2xl font-bold tabular-nums">{{ moneySum(total) }}</span>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="mb-1 block text-xs text-muted-foreground">Chegirma</label>
            <input v-model.number="discount" type="number" min="0" class="h-9 w-full rounded-md border bg-background px-2 text-sm tabular-nums" />
          </div>
          <div>
            <label class="mb-1 block text-xs text-muted-foreground">Naqd</label>
            <div class="flex gap-1.5">
              <input v-model.number="paidCash" type="number" min="0" class="h-9 w-full rounded-md border bg-background px-2 text-sm tabular-nums" />
              <button @click="setExact" title="Aniq summa" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-primary"><Magnet class="h-4 w-4 rotate-90" /></button>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap gap-1.5">
          <button v-for="q in quickCash" :key="q" @click="paidCash = q" class="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted">{{ money(q) }}</button>
        </div>

        <div>
          <label class="mb-1 block text-xs text-muted-foreground">Karta</label>
          <input v-model.number="paidCard" type="number" min="0" class="h-9 w-full rounded-md border bg-background px-2 text-sm tabular-nums" />
        </div>

        <div v-if="change > 0" class="flex justify-between text-sm"><span class="text-muted-foreground">Qaytim</span><span class="font-semibold tabular-nums">{{ moneySum(change) }}</span></div>
        <!-- Hozirgi: shu sotuv qarzi -->
        <div v-if="debt > 0 && !debtBlocked" class="flex justify-between text-sm text-rose-600"><span>Qarz (shu sotuv)</span><span class="font-semibold tabular-nums">{{ moneySum(debt) }}</span></div>
        <!-- Saldoni hisobga olgan: sotuvdan keyingi yangi saldo -->
        <div v-if="selectedCustomer && !selectedCustomer.is_walk_in" class="flex justify-between text-sm">
          <span class="text-muted-foreground">Saldo (sotuvdan keyin)</span>
          <span class="font-semibold tabular-nums" :class="balanceAfter < 0 ? 'text-rose-600' : balanceAfter > 0 ? 'text-emerald-600' : 'text-muted-foreground'">
            {{ moneySum(Math.abs(balanceAfter)) }}<span class="font-normal text-muted-foreground">{{ balanceAfter < 0 ? ' · qarzdor' : balanceAfter > 0 ? ' · haqdor' : '' }}</span>
          </span>
        </div>
        <div v-if="debtBlocked" class="rounded-md bg-rose-500/10 px-3 py-2 text-center text-xs font-medium text-rose-600">Yo'l-yo'lakay xaridorga qarzga bo'lmaydi</div>

        <button :disabled="!canSubmit || submitting" @click="submit"
          class="h-12 w-full rounded-lg bg-primary text-base font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50">
          Sotuvni yakunlash
        </button>
      </div>
    </aside>

    <!-- Mobil mini savat bar — app tab bar ustida suzadi -->
    <button
      v-if="!cartOpen"
      type="button"
      @click="cartOpen = true"
      class="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.6rem)] z-30 flex items-center gap-3 rounded-2xl border border-border/50 bg-primary px-4 py-3 text-primary-foreground shadow-lg backdrop-blur-xl active:scale-[0.98] lg:hidden"
    >
      <div class="relative">
        <ShoppingCart class="h-5 w-5" />
        <span v-if="cart.length" class="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-background px-1 text-[10px] font-bold text-foreground">{{ cart.length }}</span>
      </div>
      <span class="text-sm font-semibold">Savat</span>
      <span class="ml-auto text-base font-bold tabular-nums">{{ moneySum(total) }}</span>
      <ChevronUp class="h-4 w-4 opacity-80" />
    </button>
  </div>

  <!-- Smena yopish -->
  <div v-if="showClose" class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4">
    <div class="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl border bg-card p-5">
      <div class="mb-3 text-lg font-semibold">Smenani yopish</div>
      <div class="mb-3 space-y-1 rounded-md bg-muted/40 p-3 text-sm">
        <div class="flex justify-between"><span class="text-muted-foreground">Sotuvlar</span><strong>{{ stats.sales_count }} ta</strong></div>
        <div class="flex justify-between"><span class="text-muted-foreground">Jami</span><strong>{{ moneySum(stats.total_sales) }}</strong></div>
      </div>
      <label class="mb-1 block text-sm font-medium">Kassadagi naqd ({{ currencySymbol }})</label>
      <input v-model.number="closeCashInput" type="number" min="0" class="mb-4 h-10 w-full rounded-md border bg-background px-3 text-sm" />
      <div class="flex gap-2">
        <button @click="doCloseShift" class="h-10 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Yopish</button>
        <button @click="showClose = false" class="h-10 rounded-md border px-4 text-sm hover:bg-muted">Bekor</button>
      </div>
    </div>
  </div>

  <!-- Chek modal -->
  <div v-if="receipt" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 print:static print:bg-transparent print:p-0">
    <div class="receipt-print max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl border bg-card p-5 print:max-h-none print:max-w-none print:overflow-visible print:rounded-none print:border-0 print:shadow-none">
      <div class="mb-3 text-center">
        <div class="text-lg font-bold">OpenSales POS</div>
        <div class="text-sm text-muted-foreground">Chek #{{ receipt.receipt_number }}</div>
        <div class="text-xs text-muted-foreground">{{ formatDateTime(receipt.created_at) }} · {{ receipt.customer }}</div>
      </div>
      <table class="w-full text-sm">
        <thead><tr class="border-b text-left text-xs text-muted-foreground"><th class="py-1">Tovar</th><th class="py-1 text-right">Soni</th><th class="py-1 text-right">Summa</th></tr></thead>
        <tbody>
          <tr v-for="(it, i) in receipt.items" :key="i" class="border-b border-dashed border-border/50">
            <td class="py-1.5">{{ it.name }}<div class="text-xs text-muted-foreground">{{ moneySum(it.price) }} /{{ it.unit }}</div></td>
            <td class="py-1.5 text-right tabular-nums">{{ it.qty }}</td>
            <td class="py-1.5 text-right font-medium tabular-nums">{{ moneySum(it.subtotal) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="mt-3 space-y-1 border-t pt-3 text-sm">
        <div v-if="receipt.discount > 0" class="flex justify-between text-muted-foreground"><span>Chegirma</span><span>− {{ moneySum(receipt.discount) }}</span></div>
        <div class="flex justify-between text-base font-bold"><span>JAMI</span><span class="tabular-nums">{{ moneySum(receipt.total) }}</span></div>
        <div v-if="receipt.paid_cash > 0" class="flex justify-between"><span class="text-muted-foreground">Naqd</span><span class="tabular-nums">{{ moneySum(receipt.paid_cash) }}</span></div>
        <div v-if="receipt.paid_card > 0" class="flex justify-between"><span class="text-muted-foreground">Karta</span><span class="tabular-nums">{{ moneySum(receipt.paid_card) }}</span></div>
        <div v-if="receipt.change > 0" class="flex justify-between"><span class="text-muted-foreground">Qaytim</span><span class="tabular-nums">{{ moneySum(receipt.change) }}</span></div>
        <div v-if="receipt.debt > 0" class="flex justify-between font-semibold text-rose-600"><span>Qarz</span><span class="tabular-nums">{{ moneySum(receipt.debt) }}</span></div>
      </div>
      <div class="mt-3 text-center text-xs text-muted-foreground print:mt-4">Xaridingiz uchun rahmat!</div>
      <div class="mt-4 flex gap-2 print:hidden">
        <button @click="doPrint" class="h-10 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Chop etish</button>
        <button @click="receipt = null" class="h-10 rounded-md border px-4 text-sm hover:bg-muted">Yopish</button>
      </div>
    </div>
  </div>

  <!-- Mahsulot × mijoz sotuv tarixi -->
  <div v-if="histModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <div class="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border bg-card">
      <div class="flex shrink-0 items-start justify-between border-b p-4">
        <div class="min-w-0">
          <div class="flex items-center gap-2 text-sm font-semibold"><History class="h-4 w-4 shrink-0" /> Sotuv tarixi</div>
          <div class="mt-0.5 truncate text-xs text-muted-foreground">{{ histModal.name }} · {{ selectedCustomer?.name ?? '—' }}</div>
        </div>
        <button @click="histModal = null" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"><X class="h-4 w-4" /></button>
      </div>

      <div class="min-h-0 flex-1 overflow-auto">
        <div v-if="histRows.length === 0" class="px-4 py-12 text-center text-sm text-muted-foreground">Bu mijozga avval sotilmagan</div>
        <table v-else class="w-full text-sm">
          <thead class="sticky top-0 bg-muted">
            <tr class="text-left text-xs text-muted-foreground">
              <th class="px-4 py-2 font-medium">Sana</th>
              <th class="px-2 py-2 text-right font-medium">Soni</th>
              <th class="px-2 py-2 text-right font-medium">Narx</th>
              <th class="px-4 py-2 text-right font-medium">Summa</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in histRows" :key="r.sale_id" class="border-b border-border/50">
              <td class="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground">{{ formatDateTime(r.created_at) }}</td>
              <td class="px-2 py-2 text-right tabular-nums">{{ r.qty }} {{ r.unit }}</td>
              <td class="px-2 py-2 text-right tabular-nums">{{ moneySum(r.price) }}</td>
              <td class="px-4 py-2 text-right font-medium tabular-nums">{{ moneySum(r.subtotal) }}</td>
            </tr>
          </tbody>
          <tfoot class="sticky bottom-0 bg-muted">
            <tr class="font-semibold">
              <td class="px-4 py-2">Jami</td>
              <td class="px-2 py-2 text-right tabular-nums">{{ histTotalQty }}</td>
              <td class="px-2 py-2"></td>
              <td class="px-4 py-2 text-right tabular-nums">{{ moneySum(histTotalSum) }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  </div>

  <!-- Toast -->
  <div v-if="toast" class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background shadow-lg print:hidden">{{ toast }}</div>
</template>

<style>
@media print {
  body * { visibility: hidden; }
  .receipt-print, .receipt-print * { visibility: visible; }
  .receipt-print { position: absolute; left: 0; top: 0; width: 80mm; }
}
</style>
