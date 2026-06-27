<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { Plus, Pencil, Trash2, Search, Package, ImagePlus, X, Eye, EyeOff, Boxes, Coins, AlertTriangle, PackageX, Percent, ArrowUp, ArrowDown, Sparkles, Printer, ScanLine } from 'lucide-vue-next'
import {
  listProducts, listCategories, saveProduct, deleteProduct, setProductActive,
  bulkPricePreview, bulkAdjustPrices, type Product, type Category, type BulkPriceParams, type BulkPricePreviewRow,
} from '../lib/db'
import { moneySum, translitMatch } from '../lib/format'
import SearchableSelect from '../components/SearchableSelect.vue'
import QrScanButton from '../components/QrScanButton.vue'
import QrScanner from '../components/QrScanner.vue'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'
import { generateUniqueBarcode, barcodeDataUrl } from '../lib/barcode'
import { printLabel } from '../lib/print'

const products = ref<Product[]>([])
const categories = ref<Category[]>([])
const search = ref('')
const catFilter = ref<number | null>(null)
const stockFilter = ref<'all' | 'in' | 'low' | 'out'>('all')
const statusFilter = ref<'all' | 'active' | 'inactive'>('all')
const showForm = ref(false)
const form = ref<Partial<Product>>({ name: '', price: 0, cost_price: 0, stock: 0, unit: 'dona', category_id: null, image: null, barcode: null, barcode_type: null })

const LOW = 10
async function load() { ;[products.value, categories.value] = await Promise.all([listProducts(false), listCategories()]) }
onMounted(load)

const visible = computed(() => {
  let list = products.value
  if (catFilter.value) list = list.filter((p) => p.category_id === catFilter.value)
  if (stockFilter.value === 'in') list = list.filter((p) => p.stock > LOW)
  else if (stockFilter.value === 'low') list = list.filter((p) => p.stock > 0 && p.stock <= LOW)
  else if (stockFilter.value === 'out') list = list.filter((p) => p.stock <= 0)
  if (statusFilter.value === 'active') list = list.filter((p) => p.is_active)
  else if (statusFilter.value === 'inactive') list = list.filter((p) => !p.is_active)
  if (search.value.trim()) list = list.filter((p) => translitMatch(p.name, search.value))
  return list
})

const stats = computed(() => {
  const act = products.value.filter((p) => p.is_active)
  return {
    count: act.length,
    value: act.reduce((s, p) => s + p.price * p.stock, 0),
    low: act.filter((p) => p.stock > 0 && p.stock <= LOW).length,
    out: act.filter((p) => p.stock <= 0).length,
  }
})
const totalValue = computed(() => visible.value.reduce((s, p) => s + p.price * p.stock, 0))
function pickStock(v: 'all' | 'in' | 'low' | 'out') { stockFilter.value = stockFilter.value === v ? 'all' : v }
const catItems = computed(() => categories.value.map((c) => ({ value: c.id, label: c.name })))
function catName(id: number | null) { return categories.value.find((c) => c.id === id)?.name ?? '—' }

// Rasmni resize (max 512px) + webp'ga siqib saqlash. WebKit webp encode'ni
// qo'llamasa, jpeg'ga fallback. DB hajmini kichraytiradi.
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const MAX = 512
        let { width: w, height: h } = img
        if (w > h && w > MAX) { h = Math.round((h * MAX) / w); w = MAX }
        else if (h > MAX) { w = Math.round((w * MAX) / h); h = MAX }
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
        let out = canvas.toDataURL('image/webp', 0.8)
        if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/jpeg', 0.85)
        resolve(out)
      }
      img.onerror = reject
      img.src = reader.result as string
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function onImage(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try { form.value.image = await compressImage(file) }
  catch { notify('Rasmni o\'qib bo\'lmadi', 'error') }
}
function openNew() { form.value = { name: '', price: 0, cost_price: 0, stock: 0, unit: 'dona', category_id: categories.value[0]?.id ?? null, image: null, barcode: null, barcode_type: null }; showForm.value = true }
function openEdit(p: Product) { form.value = { ...p }; showForm.value = true }

// --- Global skaner (kassa kabi): mavjud kod → tahrir, yangi kod → yaratish ---
const showScanner = ref(false)
function handleScan(code: string, format?: string) {
  const c = code.trim()
  if (!c) return
  const exist = products.value.find((p) => p.barcode === c) // aktiv/deaktiv farqsiz
  if (exist) { openEdit(exist); return }
  openNew()
  form.value.barcode = c
  form.value.barcode_type = format || 'AUTO'
}
// Dock kamera ochiq qoladi (kassa kabi). Forma/Narxlar ochiq bo'lsa skan e'tiborsiz — qayta ochmaydi.
function onCameraScan(text: string, format: string) {
  if (showForm.value || showBulk.value) return
  handleScan(text, format)
}
// Qidiruv maydonига fokus bo'lganда USB skaner shu yerга yozadi — Enter'да skan kabi ishlaymiz.
function onSearchEnter() {
  const q = search.value.trim()
  if (!q) return
  const exist = products.value.find((p) => p.barcode === q)
  if (exist) { openEdit(exist); search.value = ''; return }
  if (visible.value.length === 1) { openEdit(visible.value[0]); search.value = ''; return }
  // Topilmadi va probelsiz uzun qator — yangi shtrix kod deb yaratish oynasini ochamiz.
  if (!/\s/.test(q) && q.length >= 6) { openNew(); form.value.barcode = q; form.value.barcode_type = 'AUTO'; search.value = '' }
}

// USB shtrix skaner (keyboard-wedge) — tez belgilar + Enter, fokussiz ham ishlaydi.
let scanBuf = ''
let lastKey = 0
function onGlobalKey(e: KeyboardEvent) {
  if (showScanner.value || showForm.value || showBulk.value) return // modal ochiq — global skan o'chiq
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  const now = Date.now()
  if (now - lastKey > 100) scanBuf = ''
  lastKey = now
  if (e.key === 'Enter') {
    if (scanBuf.length >= 3) { e.preventDefault(); handleScan(scanBuf) }
    scanBuf = ''
  } else if (e.key.length === 1) {
    scanBuf += e.key
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))
// --- Shtrix kod: generatsiya, ko'rish, yorliq chop etish ---
const genBusy = ref(false)
const labelCopies = ref(1)
const labelSize = ref('40mm 30mm')
// Preview AYNAN saqlangan formatда (QR/DataMatrix/EAN...).
const barcodePreview = computed(() => (form.value.barcode?.trim() ? barcodeDataUrl(form.value.barcode.trim(), form.value.barcode_type, { scale: 3 }) : ''))
// Skan qilinса — matn + simbologiya saqlanadi (o'sha turда chop etiladi).
function onBarcodeScan(text: string, format: string) { form.value.barcode = text; form.value.barcode_type = format || 'AUTO' }
// Qo'lда yozilса — tur auto (tarkибга qarab).
function onBarcodeInput() { form.value.barcode_type = 'AUTO' }
async function genBarcode() {
  genBusy.value = true
  try { form.value.barcode = await generateUniqueBarcode(); form.value.barcode_type = 'EAN_13' }
  finally { genBusy.value = false }
}
async function printProductLabel() {
  const code = form.value.barcode?.trim()
  if (!code) { notify('Avval kod kiriting, skanерланг yoki generatsiya qiling', 'error'); return }
  await printLabel({ name: form.value.name || '—', price: form.value.price || 0, barcode: code, type: form.value.barcode_type, copies: labelCopies.value, size: labelSize.value })
}

async function save() {
  if (!form.value.name?.trim()) return
  try {
    await saveProduct(form.value as any)
    showForm.value = false
    await load()
    notify('Saqlandi', 'success')
  } catch (e: any) {
    notify(e?.message ?? 'Xato', 'error')
  }
}
async function toggle(p: Product) {
  await setProductActive(p.id, !p.is_active)
  await load()
  notify(p.is_active ? 'Deaktiv qilindi' : 'Aktiv qilindi', 'success')
}
async function remove(p: Product) {
  if (!(await confirmDialog(`"${p.name}" mahsuloti o'chirilsinmi?`, { danger: true }))) return
  try { await deleteProduct(p.id); await load(); notify("Mahsulot o'chirildi", 'success') }
  catch (e: any) { notify(e?.message ?? 'Xato', 'error') }
}

// --- Narxlarni ommaviy o'zgartirish ---
const showBulk = ref(false)
const bulk = ref<BulkPriceParams>({ scope: 'all', categoryId: null, mode: 'percent', direction: 'up', value: 0 })
const bulkPrev = ref<{ count: number; preview: BulkPricePreviewRow[] }>({ count: 0, preview: [] })
const bulkBusy = ref(false)
function openBulk() {
  bulk.value = { scope: 'all', categoryId: categories.value[0]?.id ?? null, mode: 'percent', direction: 'up', value: 0 }
  bulkPrev.value = { count: 0, preview: [] }
  showBulk.value = true
}
async function refreshBulkPreview() {
  if (!showBulk.value) return
  if (!bulk.value.value || bulk.value.value <= 0) { bulkPrev.value = { count: 0, preview: [] }; return }
  bulkPrev.value = await bulkPricePreview(bulk.value)
}
watch(bulk, refreshBulkPreview, { deep: true })
async function applyBulk() {
  if (!bulk.value.value || bulk.value.value <= 0) { notify('Qiymat kiriting', 'error'); return }
  if (bulk.value.scope === 'category' && !bulk.value.categoryId) { notify('Kategoriya tanlang', 'error'); return }
  const scopeTxt = bulk.value.scope === 'all' ? 'barcha mahsulotlar' : `"${catName(bulk.value.categoryId ?? null)}" kategoriyasi`
  const dirTxt = bulk.value.direction === 'up' ? 'oshiriladi' : 'kamaytiriladi'
  const valTxt = bulk.value.mode === 'percent' ? `${bulk.value.value}%` : moneySum(bulk.value.value)
  if (!(await confirmDialog(`${scopeTxt} narxi ${valTxt} ga ${dirTxt} (${bulkPrev.value.count} ta). Davom etilsinmi?`, { title: 'Narxlarni o\'zgartirish' }))) return
  bulkBusy.value = true
  try {
    const n = await bulkAdjustPrices(bulk.value)
    await load()
    showBulk.value = false
    notify(`Narx yangilandi: ${n} ta mahsulot`, 'success')
  } catch (e: any) { notify(e?.message ?? 'Xato', 'error') }
  finally { bulkBusy.value = false }
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="page-header flex items-center justify-between gap-2">
      <div class="min-w-0">
        <h1 class="text-lg font-semibold">Mahsulotlar</h1>
        <p class="truncate text-sm text-muted-foreground">{{ stats.count }} ta · ombor qiymati {{ moneySum(stats.value) }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button @click="showScanner = true" title="Kod skanerlash" class="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition hover:bg-muted"><ScanLine class="h-4 w-4" /> <span class="hidden sm:inline">Skaner</span></button>
        <button @click="openBulk" class="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition hover:bg-muted"><Percent class="h-4 w-4" /> <span class="hidden sm:inline">Narxlar</span></button>
        <button @click="openNew" class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"><Plus class="h-4 w-4" /> Yangi</button>
      </div>
    </header>

    <!-- Stat kartalar -->
    <div class="grid grid-cols-2 gap-2.5 border-b px-4 py-3 sm:gap-3 sm:px-6 sm:py-4 lg:grid-cols-4">
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Boxes class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Mahsulotlar</div><div class="text-lg font-bold tabular-nums">{{ stats.count }}</div></div>
      </div>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><Coins class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Ombor qiymati</div><div class="text-lg font-bold tabular-nums">{{ moneySum(stats.value) }}</div></div>
      </div>
      <button @click="pickStock('low')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="stockFilter === 'low' ? 'border-amber-500 ring-1 ring-amber-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600"><AlertTriangle class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Kam qolgan</div><div class="text-lg font-bold tabular-nums">{{ stats.low }}</div></div>
      </button>
      <button @click="pickStock('out')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="stockFilter === 'out' ? 'border-rose-500 ring-1 ring-rose-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600"><PackageX class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Tugagan</div><div class="text-lg font-bold tabular-nums">{{ stats.out }}</div></div>
      </button>
    </div>

    <!-- Filtrlar -->
    <div class="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6">
      <div class="relative w-full sm:min-w-48 sm:flex-1">
        <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input v-model="search" @keyup.enter="onSearchEnter" placeholder="Mahsulot qidirish yoki kod skanerlash…" class="h-9 w-full rounded-lg border bg-background pl-9 pr-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
      </div>
      <div class="w-full sm:w-52"><SearchableSelect v-model="catFilter" :items="catItems" placeholder="Barcha kategoriyalar" search-placeholder="Kategoriya…" clearable /></div>
      <select v-model="stockFilter" class="h-9 flex-1 rounded-lg border bg-card px-3 text-sm sm:flex-none">
        <option value="all">Barcha qoldiq</option>
        <option value="in">Yetarli</option>
        <option value="low">Kam ({{ '≤' + LOW }})</option>
        <option value="out">Tugagan</option>
      </select>
      <select v-model="statusFilter" class="h-9 flex-1 rounded-lg border bg-card px-3 text-sm sm:flex-none">
        <option value="all">Hammasi</option>
        <option value="active">Aktiv</option>
        <option value="inactive">Deaktiv</option>
      </select>
    </div>

    <div class="flex-1 overflow-auto pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-0">
      <!-- Mobil: kartalar ro'yxati -->
      <ul class="divide-y lg:hidden">
        <li v-for="p in visible" :key="p.id" class="flex items-center gap-3 px-4 py-3" :class="p.is_active ? '' : 'opacity-50'">
          <img v-if="p.image" :src="p.image" class="h-12 w-12 shrink-0 rounded-lg border object-cover" />
          <div v-else class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground"><Package class="h-5 w-5" /></div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate font-medium">{{ p.name }}</span>
              <span v-if="!p.is_active" class="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-rose-600 uppercase">Deaktiv</span>
            </div>
            <div class="mt-0.5 truncate text-xs text-muted-foreground">{{ catName(p.category_id) }}</div>
            <div class="mt-1 flex items-center gap-2 text-sm">
              <span class="font-semibold tabular-nums">{{ moneySum(p.price) }}</span>
              <span class="tabular-nums" :class="p.stock <= 0 ? 'text-rose-500' : p.stock <= LOW ? 'text-amber-600' : 'text-muted-foreground'">· {{ p.stock }} {{ p.unit }}</span>
            </div>
          </div>
          <div class="flex shrink-0 flex-col items-end gap-1.5">
            <div class="flex items-center gap-0.5">
              <button @click="openEdit(p)" class="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil class="h-4 w-4" /></button>
              <button @click="toggle(p)" class="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><component :is="p.is_active ? EyeOff : Eye" class="h-4 w-4" /></button>
              <button @click="remove(p)" class="rounded p-2 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"><Trash2 class="h-4 w-4" /></button>
            </div>
            <span class="text-xs text-muted-foreground tabular-nums">{{ moneySum(p.price * p.stock) }}</span>
          </div>
        </li>
        <li v-if="visible.length === 0" class="px-4 py-16 text-center text-muted-foreground"><Package class="mx-auto mb-2 h-8 w-8 opacity-40" /> Mahsulot topilmadi</li>
        <li v-if="visible.length" class="flex justify-between bg-muted/40 px-4 py-3 text-sm font-semibold"><span>Jami: {{ visible.length }} ta</span><span class="tabular-nums">{{ moneySum(totalValue) }}</span></li>
      </ul>

      <table class="hidden w-full text-sm lg:table">
        <thead class="sticky top-0 z-10 border-b bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr><th class="px-4 py-3">Nom</th><th class="px-4 py-3">Kategoriya</th><th class="px-4 py-3 text-right">Narx</th><th class="px-4 py-3 text-right">Qoldiq</th><th class="px-4 py-3 text-right">Qiymat</th><th class="px-4 py-3"></th></tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="p in visible" :key="p.id" class="hover:bg-muted/40" :class="p.is_active ? '' : 'opacity-50'">
            <td class="px-4 py-3 font-medium">
              <div class="flex items-center gap-2.5">
                <img v-if="p.image" :src="p.image" class="h-9 w-9 rounded-md border object-cover" />
                <div v-else class="flex h-9 w-9 items-center justify-center rounded-md border bg-muted text-muted-foreground"><Package class="h-4 w-4" /></div>
                <span class="flex items-center gap-2">{{ p.name }}<span v-if="!p.is_active" class="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-rose-600 uppercase">Deaktiv</span></span>
              </div>
            </td>
            <td class="px-4 py-3 text-muted-foreground">{{ catName(p.category_id) }}</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(p.price) }}</td>
            <td class="px-4 py-3 text-right tabular-nums" :class="p.stock <= 0 ? 'text-rose-500' : p.stock <= LOW ? 'text-amber-600' : ''">{{ p.stock }} {{ p.unit }}</td>
            <td class="px-4 py-3 text-right tabular-nums text-muted-foreground">{{ moneySum(p.price * p.stock) }}</td>
            <td class="px-4 py-3">
              <div class="flex items-center justify-end gap-0.5">
                <button @click="openEdit(p)" title="Tahrirlash" class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil class="h-4 w-4" /></button>
                <button @click="toggle(p)" :title="p.is_active ? 'Deaktiv qilish' : 'Aktiv qilish'" class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><component :is="p.is_active ? EyeOff : Eye" class="h-4 w-4" /></button>
                <button @click="remove(p)" title="O'chirish" class="rounded p-1.5 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"><Trash2 class="h-4 w-4" /></button>
              </div>
            </td>
          </tr>
          <tr v-if="visible.length === 0"><td colspan="6" class="px-4 py-16 text-center text-muted-foreground"><Package class="mx-auto mb-2 h-8 w-8 opacity-40" /> Mahsulot topilmadi</td></tr>
        </tbody>
        <tfoot v-if="visible.length" class="sticky bottom-0 border-t-2 bg-card text-sm font-semibold">
          <tr>
            <td class="px-4 py-3" colspan="4">Jami: {{ visible.length }} ta</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(totalValue) }}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="max-h-[90vh] w-full max-w-md overflow-auto rounded-xl border bg-card p-5 shadow-xl">
        <div class="mb-4 text-lg font-semibold">{{ form.id ? 'Tahrirlash' : 'Yangi mahsulot' }}</div>
        <div class="space-y-3">
          <div class="flex items-center gap-3">
            <div class="relative h-16 w-16 shrink-0">
              <img v-if="form.image" :src="form.image" class="h-16 w-16 rounded-lg border object-cover" />
              <div v-else class="flex h-16 w-16 items-center justify-center rounded-lg border bg-muted text-muted-foreground"><Package class="h-6 w-6" /></div>
              <button v-if="form.image" @click="form.image = null" class="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-white"><X class="h-3 w-3" /></button>
            </div>
            <label class="flex h-9 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-muted">
              <ImagePlus class="h-4 w-4" /> Rasm tanlash
              <input type="file" accept="image/*" class="hidden" @change="onImage" />
            </label>
          </div>
          <div><label class="mb-1 block text-sm font-medium">Nomi</label><input v-model="form.name" class="h-10 w-full rounded-md border bg-background px-3 text-sm" /></div>
          <div>
            <label class="mb-1 block text-sm font-medium">Shtrix / QR kod</label>
            <div class="flex gap-2">
              <input v-model="form.barcode" @input="onBarcodeInput" placeholder="Skanerlang, kiriting yoki generatsiya qiling" class="h-10 w-full rounded-md border bg-background px-3 text-sm tabular-nums" />
              <button type="button" @click="genBarcode" :disabled="genBusy" title="Yangi kod generatsiya qilish"
                class="flex w-10 shrink-0 items-center justify-center self-stretch rounded-md border bg-background text-muted-foreground transition hover:bg-muted hover:text-primary disabled:opacity-50">
                <Sparkles class="h-4 w-4" />
              </button>
              <QrScanButton @decoded="onBarcodeScan" />
            </div>
            <!-- Ko'rish + nakleyka printerда chop etish -->
            <div v-if="barcodePreview" class="mt-2 rounded-lg border bg-white p-2">
              <div class="flex justify-center"><img :src="barcodePreview" class="max-h-28" /></div>
              <div class="mt-2 flex flex-wrap items-end gap-2 border-t pt-2">
                <div>
                  <label class="mb-0.5 block text-[11px] text-muted-foreground">Nusxa</label>
                  <input v-model.number="labelCopies" type="number" min="1" max="100" class="h-8 w-16 rounded-md border bg-background px-2 text-sm tabular-nums" />
                </div>
                <div>
                  <label class="mb-0.5 block text-[11px] text-muted-foreground">Yorliq o'lchami</label>
                  <select v-model="labelSize" class="h-8 rounded-md border bg-background px-2 text-sm">
                    <option value="40mm 30mm">40×30 mm</option>
                    <option value="58mm 40mm">58×40 mm</option>
                    <option value="58mm 30mm">58×30 mm</option>
                    <option value="30mm 20mm">30×20 mm</option>
                  </select>
                </div>
                <button type="button" @click="printProductLabel"
                  class="ml-auto flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                  <Printer class="h-4 w-4" /> Yorliq chop etish
                </button>
              </div>
            </div>
          </div>
          <div><label class="mb-1 block text-sm font-medium">Kategoriya</label>
            <SearchableSelect v-model="form.category_id" :items="catItems" placeholder="Kategoriya tanlang" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="mb-1 block text-sm font-medium">Narx</label><input v-model.number="form.price" type="number" min="0" class="h-10 w-full rounded-md border bg-background px-3 text-sm tabular-nums" /></div>
            <div><label class="mb-1 block text-sm font-medium">Tannarx</label><input v-model.number="form.cost_price" type="number" min="0" class="h-10 w-full rounded-md border bg-background px-3 text-sm tabular-nums" /></div>
            <div><label class="mb-1 block text-sm font-medium">Qoldiq</label><input v-model.number="form.stock" type="number" min="0" class="h-10 w-full rounded-md border bg-background px-3 text-sm tabular-nums" /></div>
            <div><label class="mb-1 block text-sm font-medium">Birlik</label><select v-model="form.unit" class="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="dona">dona</option><option value="kg">kg</option><option value="litr">litr</option></select></div>
          </div>
        </div>
        <div class="mt-5 flex gap-2">
          <button @click="save" class="h-10 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Saqlash</button>
          <button @click="showForm = false" class="h-10 rounded-md border px-4 text-sm hover:bg-muted">Bekor</button>
        </div>
      </div>
    </div>

    <!-- Narxlarni ommaviy o'zgartirish -->
    <div v-if="showBulk" class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4">
      <div class="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border bg-card p-5 shadow-xl">
        <div class="mb-4 flex items-center gap-2 text-lg font-semibold"><Percent class="h-5 w-5 text-primary" /> Narxlarni o'zgartirish</div>
        <div class="space-y-4">
          <!-- Doira -->
          <div>
            <label class="mb-1.5 block text-sm font-medium">Qaysi mahsulotlar</label>
            <div class="grid grid-cols-2 gap-2">
              <button @click="bulk.scope = 'all'" class="h-9 rounded-md border text-sm font-medium" :class="bulk.scope === 'all' ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'">Hammasi</button>
              <button @click="bulk.scope = 'category'" class="h-9 rounded-md border text-sm font-medium" :class="bulk.scope === 'category' ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'">Kategoriya</button>
            </div>
            <div v-if="bulk.scope === 'category'" class="mt-2">
              <SearchableSelect v-model="bulk.categoryId" :items="catItems" placeholder="Kategoriya tanlang" search-placeholder="Kategoriya…" />
            </div>
          </div>

          <!-- Yo'nalish -->
          <div>
            <label class="mb-1.5 block text-sm font-medium">Amal</label>
            <div class="grid grid-cols-2 gap-2">
              <button @click="bulk.direction = 'up'" class="flex h-9 items-center justify-center gap-1.5 rounded-md border text-sm font-medium" :class="bulk.direction === 'up' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600' : 'hover:bg-muted'"><ArrowUp class="h-4 w-4" /> Oshirish</button>
              <button @click="bulk.direction = 'down'" class="flex h-9 items-center justify-center gap-1.5 rounded-md border text-sm font-medium" :class="bulk.direction === 'down' ? 'border-rose-500 bg-rose-500/10 text-rose-600' : 'hover:bg-muted'"><ArrowDown class="h-4 w-4" /> Kamaytirish</button>
            </div>
          </div>

          <!-- Usul + qiymat -->
          <div>
            <label class="mb-1.5 block text-sm font-medium">Qancha</label>
            <div class="flex gap-2">
              <div class="inline-flex shrink-0 rounded-md border p-0.5">
                <button @click="bulk.mode = 'percent'" class="h-8 rounded px-3 text-sm font-medium" :class="bulk.mode === 'percent' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'">Foiz %</button>
                <button @click="bulk.mode = 'amount'" class="h-8 rounded px-3 text-sm font-medium" :class="bulk.mode === 'amount' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'">Summa</button>
              </div>
              <input v-model.number="bulk.value" type="number" min="0" :placeholder="bulk.mode === 'percent' ? '10' : '1000'" class="h-9 w-full rounded-md border bg-background px-3 text-sm tabular-nums" />
            </div>
          </div>

          <!-- Oldindan ko'rish -->
          <div v-if="bulk.value > 0" class="rounded-lg border bg-muted/30">
            <div class="border-b px-3 py-2 text-xs font-medium text-muted-foreground">{{ bulkPrev.count }} ta mahsulot o'zgaradi · misol:</div>
            <div v-if="bulkPrev.preview.length === 0" class="px-3 py-4 text-center text-sm text-muted-foreground">Mos mahsulot yo'q</div>
            <ul v-else class="max-h-44 divide-y overflow-auto">
              <li v-for="r in bulkPrev.preview" :key="r.id" class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                <span class="min-w-0 flex-1 truncate">{{ r.name }}</span>
                <span class="shrink-0 tabular-nums text-muted-foreground line-through">{{ moneySum(r.old_price) }}</span>
                <span class="shrink-0 tabular-nums font-semibold" :class="r.new_price >= r.old_price ? 'text-emerald-600' : 'text-rose-600'">{{ moneySum(r.new_price) }}</span>
              </li>
            </ul>
          </div>
        </div>

        <div class="mt-5 flex gap-2">
          <button @click="applyBulk" :disabled="bulkBusy || !bulk.value || bulkPrev.count === 0" class="h-10 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">Qo'llash</button>
          <button @click="showBulk = false" class="h-10 rounded-md border px-4 text-sm hover:bg-muted">Bekor</button>
        </div>
      </div>
    </div>

    <!-- Kamera skaneri (dock, doimiy) — UI'ni to'smaydi. Kod → tahrir yoki yangi mahsulot -->
    <QrScanner v-if="showScanner" continuous dock @decoded="onCameraScan" @close="showScanner = false" />
  </div>
</template>
