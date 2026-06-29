<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Pencil, Trash2, FolderTree, Boxes, Coins, Search } from 'lucide-vue-next'
import { listCategories, saveCategory, deleteCategory, listProducts, type Category } from '../lib/db'
import { moneySum, translitMatch } from '../lib/format'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'

const { t } = useI18n()

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
async function save() { if (!name.value.trim()) return; await saveCategory(name.value.trim(), editId.value); showForm.value = false; await load(); notify(t('categories.saved'), 'success') }
async function remove(c: Category) {
  if (!(await confirmDialog(t('categories.confirmDelete', { name: c.name }), { danger: true }))) return
  try { await deleteCategory(c.id); await load(); notify(t('categories.deleted'), 'success') }
  catch (e: any) { notify(e?.message ?? t('categories.deleteError'), 'error') }
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="page-header flex items-center justify-between gap-2">
      <div class="min-w-0">
        <h1 class="text-lg font-semibold">{{ $t('categories.title') }}</h1>
        <p class="truncate text-sm text-muted-foreground">{{ $t('categories.headerSummary', { count: stats.count, products: stats.products }) }}</p>
      </div>
      <button @click="openNew" class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"><Plus class="h-4 w-4" /> {{ $t('categories.new') }}</button>
    </header>

    <!-- Stat kartalar -->
    <div class="grid grid-cols-3 gap-2.5 border-b px-4 py-3 sm:gap-3 sm:px-6 sm:py-4">
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><FolderTree class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('categories.title') }}</div><div class="text-lg font-bold tabular-nums">{{ stats.count }}</div></div>
      </div>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600"><Boxes class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('categories.products') }}</div><div class="text-lg font-bold tabular-nums">{{ stats.products }}</div></div>
      </div>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><Coins class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('categories.stockValue') }}</div><div class="text-lg font-bold tabular-nums">{{ moneySum(stats.value) }}</div></div>
      </div>
    </div>

    <!-- Filtrlar -->
    <div class="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6">
      <div class="relative w-full flex-1">
        <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input v-model="search" :placeholder="$t('categories.searchPlaceholder')" class="h-9 w-full rounded-lg border bg-background pl-9 pr-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
      </div>
    </div>

    <div class="flex-1 overflow-auto pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-0">
      <!-- Mobil: kartalar ro'yxati -->
      <ul class="divide-y lg:hidden">
        <li v-for="c in visible" :key="c.id" class="flex items-center gap-3 px-4 py-3">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><FolderTree class="h-5 w-5" /></div>
          <div class="min-w-0 flex-1">
            <div class="truncate font-medium">{{ c.name }}</div>
            <div class="mt-0.5 text-xs text-muted-foreground tabular-nums">{{ $t('categories.itemCount', { count: counts[c.id]?.n ?? 0 }) }} · {{ moneySum(counts[c.id]?.sum ?? 0) }}</div>
          </div>
          <div class="flex shrink-0 items-center gap-0.5">
            <button @click="openEdit(c)" :title="$t('common.edit')" class="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil class="h-4 w-4" /></button>
            <button @click="remove(c)" :title="$t('common.delete')" class="rounded p-2 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"><Trash2 class="h-4 w-4" /></button>
          </div>
        </li>
        <li v-if="visible.length === 0" class="px-4 py-16 text-center text-muted-foreground"><FolderTree class="mx-auto mb-2 h-8 w-8 opacity-40" /> {{ $t('categories.notFound') }}</li>
        <li v-if="visible.length" class="flex justify-between bg-muted/40 px-4 py-3 text-sm font-semibold"><span>{{ $t('categories.totalCount', { count: visible.length }) }}</span><span class="tabular-nums">{{ moneySum(visValue) }}</span></li>
      </ul>

      <table class="hidden w-full text-sm lg:table">
        <thead class="sticky top-0 z-10 border-b bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr><th class="px-4 py-3">{{ $t('categories.colName') }}</th><th class="px-4 py-3 text-right">{{ $t('categories.products') }}</th><th class="px-4 py-3 text-right">{{ $t('categories.colValue') }}</th><th class="px-4 py-3"></th></tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="c in visible" :key="c.id" class="hover:bg-muted/40">
            <td class="px-4 py-3 font-medium">
              <div class="flex items-center gap-2.5">
                <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><FolderTree class="h-4.5 w-4.5" /></div>
                {{ c.name }}
              </div>
            </td>
            <td class="px-4 py-3 text-right tabular-nums">{{ $t('categories.itemCount', { count: counts[c.id]?.n ?? 0 }) }}</td>
            <td class="px-4 py-3 text-right tabular-nums text-muted-foreground">{{ moneySum(counts[c.id]?.sum ?? 0) }}</td>
            <td class="px-4 py-3">
              <div class="flex items-center justify-end gap-0.5">
                <button @click="openEdit(c)" :title="$t('common.edit')" class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil class="h-4 w-4" /></button>
                <button @click="remove(c)" :title="$t('common.delete')" class="rounded p-1.5 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"><Trash2 class="h-4 w-4" /></button>
              </div>
            </td>
          </tr>
          <tr v-if="visible.length === 0"><td colspan="4" class="px-4 py-16 text-center text-muted-foreground"><FolderTree class="mx-auto mb-2 h-8 w-8 opacity-40" /> {{ $t('categories.notFound') }}</td></tr>
        </tbody>
        <tfoot v-if="visible.length" class="sticky bottom-0 border-t-2 bg-card text-sm font-semibold">
          <tr>
            <td class="px-4 py-3">{{ $t('categories.totalCount', { count: visible.length }) }}</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ $t('categories.itemCount', { count: visible.reduce((s, c) => s + (counts[c.id]?.n ?? 0), 0) }) }}</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(visValue) }}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl border bg-card p-5 shadow-xl">
        <div class="mb-3 text-lg font-semibold">{{ editId ? $t('common.edit') : $t('categories.newCategory') }}</div>
        <input v-model="name" autofocus :placeholder="$t('categories.namePlaceholder')" class="mb-4 h-10 w-full rounded-md border bg-background px-3 text-sm" @keyup.enter="save" />
        <div class="flex gap-2">
          <button @click="save" class="h-10 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">{{ $t('common.save') }}</button>
          <button @click="showForm = false" class="h-10 rounded-md border px-4 text-sm hover:bg-muted">{{ $t('common.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
