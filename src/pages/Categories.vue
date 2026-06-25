<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Plus, Pencil, Trash2, FolderTree, Boxes, Coins, Search } from 'lucide-vue-next'
import { listCategories, saveCategory, deleteCategory, listProducts, type Category } from '../lib/db'
import { moneySum, translitMatch } from '../lib/format'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'

type CatStat = { n: number; sum: number }
const cats = ref<Category[]>([])
const counts = ref<Record<number, CatStat>>({})
const search = ref('')
const showForm = ref(false)
const name = ref('')
const editId = ref<number | undefined>()

async function load() {
  cats.value = await listCategories()
  const prods = await listProducts(false)
  const c: Record<number, CatStat> = {}
  for (const p of prods) {
    if (!p.category_id) continue
    const s = (c[p.category_id] ??= { n: 0, sum: 0 })
    s.n += 1
    s.sum += p.price * p.stock
  }
  counts.value = c
}
onMounted(load)

const visible = computed(() => (search.value.trim() ? cats.value.filter((c) => translitMatch(c.name, search.value)) : cats.value))
const stats = computed(() => ({
  count: cats.value.length,
  products: Object.values(counts.value).reduce((s, x) => s + x.n, 0),
  value: Object.values(counts.value).reduce((s, x) => s + x.sum, 0),
}))
const visValue = computed(() => visible.value.reduce((s, c) => s + (counts.value[c.id]?.sum ?? 0), 0))

function openNew() { name.value = ''; editId.value = undefined; showForm.value = true }
function openEdit(c: Category) { name.value = c.name; editId.value = c.id; showForm.value = true }
async function save() { if (!name.value.trim()) return; await saveCategory(name.value.trim(), editId.value); showForm.value = false; await load(); notify('Saqlandi', 'success') }
async function remove(c: Category) {
  if (!(await confirmDialog(`"${c.name}" kategoriyasi o'chirilsinmi?`, { danger: true }))) return
  try { await deleteCategory(c.id); await load(); notify("Kategoriya o'chirildi", 'success') }
  catch (e: any) { notify(e?.message ?? 'Xato', 'error') }
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <div>
        <h1 class="text-lg font-semibold">Kategoriyalar</h1>
        <p class="text-sm text-muted-foreground">{{ stats.count }} ta · {{ stats.products }} mahsulot</p>
      </div>
      <button @click="openNew" class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"><Plus class="h-4 w-4" /> Yangi</button>
    </header>

    <!-- Stat kartalar -->
    <div class="grid grid-cols-3 gap-3 border-b px-6 py-4">
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><FolderTree class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Kategoriyalar</div><div class="text-lg font-bold tabular-nums">{{ stats.count }}</div></div>
      </div>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600"><Boxes class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Mahsulotlar</div><div class="text-lg font-bold tabular-nums">{{ stats.products }}</div></div>
      </div>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><Coins class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Ombor qiymati</div><div class="text-lg font-bold tabular-nums">{{ moneySum(stats.value) }}</div></div>
      </div>
    </div>

    <!-- Filtrlar -->
    <div class="flex flex-wrap items-center gap-2 border-b px-6 py-3">
      <div class="relative min-w-48 flex-1">
        <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input v-model="search" placeholder="Kategoriya qidirish…" class="h-9 w-full rounded-lg border bg-background pl-9 pr-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
      </div>
    </div>

    <div class="flex-1 overflow-auto">
      <table class="w-full text-sm">
        <thead class="sticky top-0 z-10 border-b bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr><th class="px-4 py-3">Nom</th><th class="px-4 py-3 text-right">Mahsulotlar</th><th class="px-4 py-3 text-right">Qiymat</th><th class="px-4 py-3"></th></tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="c in visible" :key="c.id" class="hover:bg-muted/40">
            <td class="px-4 py-3 font-medium">
              <div class="flex items-center gap-2.5">
                <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><FolderTree class="h-4.5 w-4.5" /></div>
                {{ c.name }}
              </div>
            </td>
            <td class="px-4 py-3 text-right tabular-nums">{{ counts[c.id]?.n ?? 0 }} ta</td>
            <td class="px-4 py-3 text-right tabular-nums text-muted-foreground">{{ moneySum(counts[c.id]?.sum ?? 0) }}</td>
            <td class="px-4 py-3">
              <div class="flex items-center justify-end gap-0.5">
                <button @click="openEdit(c)" title="Tahrirlash" class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil class="h-4 w-4" /></button>
                <button @click="remove(c)" title="O'chirish" class="rounded p-1.5 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"><Trash2 class="h-4 w-4" /></button>
              </div>
            </td>
          </tr>
          <tr v-if="visible.length === 0"><td colspan="4" class="px-4 py-16 text-center text-muted-foreground"><FolderTree class="mx-auto mb-2 h-8 w-8 opacity-40" /> Kategoriya topilmadi</td></tr>
        </tbody>
        <tfoot v-if="visible.length" class="sticky bottom-0 border-t-2 bg-card text-sm font-semibold">
          <tr>
            <td class="px-4 py-3">Jami: {{ visible.length }} ta</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ visible.reduce((s, c) => s + (counts[c.id]?.n ?? 0), 0) }} ta</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(visValue) }}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-sm rounded-xl border bg-card p-5 shadow-xl">
        <div class="mb-3 text-lg font-semibold">{{ editId ? 'Tahrirlash' : 'Yangi kategoriya' }}</div>
        <input v-model="name" autofocus placeholder="Nomi" class="mb-4 h-10 w-full rounded-md border bg-background px-3 text-sm" @keyup.enter="save" />
        <div class="flex gap-2">
          <button @click="save" class="h-10 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Saqlash</button>
          <button @click="showForm = false" class="h-10 rounded-md border px-4 text-sm hover:bg-muted">Bekor</button>
        </div>
      </div>
    </div>
  </div>
</template>
