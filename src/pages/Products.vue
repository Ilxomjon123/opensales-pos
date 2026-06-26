<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Plus, Pencil, Trash2, Search, Package, ImagePlus, X, Eye, EyeOff, Boxes, Coins, AlertTriangle, PackageX } from 'lucide-vue-next'
import { listProducts, listCategories, saveProduct, deleteProduct, setProductActive, type Product, type Category } from '../lib/db'
import { moneySum, translitMatch } from '../lib/format'
import SearchableSelect from '../components/SearchableSelect.vue'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'

const products = ref<Product[]>([])
const categories = ref<Category[]>([])
const search = ref('')
const catFilter = ref<number | null>(null)
const stockFilter = ref<'all' | 'in' | 'low' | 'out'>('all')
const statusFilter = ref<'all' | 'active' | 'inactive'>('all')
const showForm = ref(false)
const form = ref<Partial<Product>>({ name: '', price: 0, cost_price: 0, stock: 0, unit: 'dona', category_id: null, image: null })

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
function openNew() { form.value = { name: '', price: 0, cost_price: 0, stock: 0, unit: 'dona', category_id: categories.value[0]?.id ?? null, image: null }; showForm.value = true }
function openEdit(p: Product) { form.value = { ...p }; showForm.value = true }
async function save() {
  if (!form.value.name?.trim()) return
  await saveProduct(form.value as any)
  showForm.value = false
  await load()
  notify('Saqlandi', 'success')
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
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <div>
        <h1 class="text-lg font-semibold">Mahsulotlar</h1>
        <p class="text-sm text-muted-foreground">{{ stats.count }} ta · ombor qiymati {{ moneySum(stats.value) }}</p>
      </div>
      <button @click="openNew" class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"><Plus class="h-4 w-4" /> Yangi</button>
    </header>

    <!-- Stat kartalar -->
    <div class="grid grid-cols-2 gap-3 border-b px-6 py-4 lg:grid-cols-4">
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
    <div class="flex flex-wrap items-center gap-2 border-b px-6 py-3">
      <div class="relative min-w-48 flex-1">
        <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input v-model="search" placeholder="Mahsulot qidirish…" class="h-9 w-full rounded-lg border bg-background pl-9 pr-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
      </div>
      <div class="w-52"><SearchableSelect v-model="catFilter" :items="catItems" placeholder="Barcha kategoriyalar" search-placeholder="Kategoriya…" clearable /></div>
      <select v-model="stockFilter" class="h-9 rounded-lg border bg-card px-3 text-sm">
        <option value="all">Barcha qoldiq</option>
        <option value="in">Yetarli</option>
        <option value="low">Kam ({{ '≤' + LOW }})</option>
        <option value="out">Tugagan</option>
      </select>
      <select v-model="statusFilter" class="h-9 rounded-lg border bg-card px-3 text-sm">
        <option value="all">Hammasi</option>
        <option value="active">Aktiv</option>
        <option value="inactive">Deaktiv</option>
      </select>
    </div>

    <div class="flex-1 overflow-auto pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-0">
      <table class="w-full text-sm">
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
      <div class="w-full max-w-md rounded-xl border bg-card p-5 shadow-xl">
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
  </div>
</template>
