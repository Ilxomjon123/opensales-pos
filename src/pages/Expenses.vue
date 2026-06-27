<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { Plus, Pencil, Trash2, Calendar, Wallet, ReceiptText, Tag, X } from 'lucide-vue-next'
import { listExpenses, saveExpense, deleteExpense, type Expense } from '../lib/db'
import { moneySum, formatDateTime, translitMatch } from '../lib/format'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'

const CATEGORIES = ['Ijara', 'Oylik', 'Kommunal', 'Tovar', 'Transport', 'Soliq', 'Boshqa']

function iso(d: Date) { return d.toISOString().slice(0, 10) }
const now = new Date()
const dateFrom = ref(iso(new Date(now.getFullYear(), now.getMonth(), 1)))
const dateTo = ref(iso(now))
const search = ref('')
const catFilter = ref('')

const expenses = ref<Expense[]>([])
async function load() { expenses.value = await listExpenses({ dateFrom: dateFrom.value, dateTo: dateTo.value }) }
onMounted(load)
watch([dateFrom, dateTo], load)

function preset(kind: 'today' | 'week' | 'month' | 'all') {
  const t = new Date()
  if (kind === 'today') { dateFrom.value = iso(t); dateTo.value = iso(t) }
  else if (kind === 'week') { const w = new Date(); w.setDate(w.getDate() - 6); dateFrom.value = iso(w); dateTo.value = iso(t) }
  else if (kind === 'month') { dateFrom.value = iso(new Date(t.getFullYear(), t.getMonth(), 1)); dateTo.value = iso(t) }
  else { dateFrom.value = '2000-01-01'; dateTo.value = iso(t) }
}

const visible = computed(() => {
  let list = expenses.value
  if (catFilter.value) list = list.filter((e) => e.category === catFilter.value)
  if (search.value.trim()) list = list.filter((e) => translitMatch((e.note ?? '') + ' ' + e.category, search.value))
  return list
})
const total = computed(() => visible.value.reduce((s, e) => s + e.amount, 0))
// Toifalar bo'yicha jami (eng kattadan)
const byCategory = computed(() => {
  const m = new Map<string, number>()
  for (const e of visible.value) m.set(e.category, (m.get(e.category) ?? 0) + e.amount)
  return [...m.entries()].map(([category, sum]) => ({ category, sum })).sort((a, b) => b.sum - a.sum)
})
const topCat = computed(() => byCategory.value[0] ?? null)

// Forma
const showForm = ref(false)
const form = ref<{ id?: number; amount: number; category: string; note: string; date: string }>({ amount: 0, category: 'Boshqa', note: '', date: iso(new Date()) })
function openNew() { form.value = { amount: 0, category: 'Boshqa', note: '', date: iso(new Date()) }; showForm.value = true }
function openEdit(e: Expense) { form.value = { id: e.id, amount: e.amount, category: e.category, note: e.note ?? '', date: e.created_at.slice(0, 10) }; showForm.value = true }
async function save() {
  if (!form.value.amount || form.value.amount <= 0) { notify('Summa kiriting', 'error'); return }
  try {
    await saveExpense(form.value)
    showForm.value = false
    await load()
    notify('Saqlandi', 'success')
  } catch (e: any) { notify(e?.message ?? 'Xato', 'error') }
}
async function remove(e: Expense) {
  if (!(await confirmDialog(`"${e.category}" — ${moneySum(e.amount)} xarajati o'chirilsinmi?`, { danger: true }))) return
  await deleteExpense(e.id)
  await load()
  notify("O'chirildi", 'success')
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="page-header flex items-center justify-between gap-2">
      <div class="min-w-0">
        <h1 class="text-lg font-semibold">Xarajatlar</h1>
        <p class="truncate text-sm text-muted-foreground">{{ visible.length }} ta · jami {{ moneySum(total) }}</p>
      </div>
      <button @click="openNew" class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"><Plus class="h-4 w-4" /> Yangi</button>
    </header>

    <!-- Stat kartalar -->
    <div class="grid grid-cols-2 gap-2.5 border-b px-4 py-3 sm:gap-3 sm:px-6 sm:py-4 lg:grid-cols-3">
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600"><Wallet class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Jami xarajat</div><div class="text-lg font-bold tabular-nums text-rose-600">{{ moneySum(total) }}</div></div>
      </div>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><ReceiptText class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Yozuvlar</div><div class="text-lg font-bold tabular-nums">{{ visible.length }}</div></div>
      </div>
      <div class="col-span-2 flex items-center gap-3 rounded-xl border bg-card p-3 lg:col-span-1">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600"><Tag class="h-4.5 w-4.5" /></div>
        <div class="min-w-0"><div class="text-xs text-muted-foreground">Eng katta toifa</div><div class="truncate text-lg font-bold tabular-nums">{{ topCat ? `${topCat.category} · ${moneySum(topCat.sum)}` : '—' }}</div></div>
      </div>
    </div>

    <!-- Filtrlar -->
    <div class="space-y-2 border-b px-4 py-3 sm:flex sm:flex-wrap sm:items-center sm:gap-2 sm:space-y-0 sm:px-6">
      <div class="flex items-center gap-2">
        <Calendar class="h-4 w-4 shrink-0 text-muted-foreground" />
        <input v-model="dateFrom" type="date" class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm sm:flex-none" />
        <span class="text-muted-foreground">—</span>
        <input v-model="dateTo" type="date" class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm sm:flex-none" />
      </div>
      <div class="grid grid-cols-4 gap-1.5 sm:flex">
        <button @click="preset('today')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">Bugun</button>
        <button @click="preset('week')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">7 kun</button>
        <button @click="preset('month')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">Oy</button>
        <button @click="preset('all')" class="h-9 rounded-lg border bg-card px-3 text-sm hover:bg-muted">Hammasi</button>
      </div>
      <select v-model="catFilter" class="h-9 w-full rounded-lg border bg-card px-3 text-sm sm:ml-auto sm:w-44">
        <option value="">Barcha toifalar</option>
        <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
      </select>
    </div>

    <div class="flex-1 overflow-auto pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-0">
      <!-- Mobil -->
      <ul class="divide-y lg:hidden">
        <li v-for="e in visible" :key="e.id" class="flex items-center gap-3 px-4 py-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">{{ e.category }}</span>
              <span class="truncate text-sm">{{ e.note || '—' }}</span>
            </div>
            <div class="mt-0.5 text-xs text-muted-foreground">{{ formatDateTime(e.created_at) }}</div>
          </div>
          <div class="shrink-0 font-semibold tabular-nums text-rose-600">{{ moneySum(e.amount) }}</div>
          <div class="flex shrink-0 items-center gap-0.5">
            <button @click="openEdit(e)" class="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil class="h-4 w-4" /></button>
            <button @click="remove(e)" class="rounded p-2 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"><Trash2 class="h-4 w-4" /></button>
          </div>
        </li>
        <li v-if="visible.length === 0" class="px-4 py-16 text-center text-muted-foreground"><Wallet class="mx-auto mb-2 h-8 w-8 opacity-40" /> Xarajat yo'q</li>
        <li v-if="visible.length" class="flex justify-between bg-muted/40 px-4 py-3 text-sm font-semibold"><span>Jami: {{ visible.length }} ta</span><span class="tabular-nums text-rose-600">{{ moneySum(total) }}</span></li>
      </ul>

      <table class="hidden w-full text-sm lg:table">
        <thead class="sticky top-0 z-10 border-b bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr><th class="px-4 py-3">Sana</th><th class="px-4 py-3">Toifa</th><th class="px-4 py-3">Izoh</th><th class="px-4 py-3 text-right">Summa</th><th class="px-4 py-3"></th></tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="e in visible" :key="e.id" class="hover:bg-muted/40">
            <td class="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">{{ formatDateTime(e.created_at) }}</td>
            <td class="px-4 py-3"><span class="rounded bg-muted px-2 py-0.5 text-xs font-medium">{{ e.category }}</span></td>
            <td class="px-4 py-3 text-muted-foreground">{{ e.note || '—' }}</td>
            <td class="px-4 py-3 text-right font-semibold tabular-nums text-rose-600">{{ moneySum(e.amount) }}</td>
            <td class="px-4 py-3">
              <div class="flex items-center justify-end gap-0.5">
                <button @click="openEdit(e)" title="Tahrirlash" class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil class="h-4 w-4" /></button>
                <button @click="remove(e)" title="O'chirish" class="rounded p-1.5 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"><Trash2 class="h-4 w-4" /></button>
              </div>
            </td>
          </tr>
          <tr v-if="visible.length === 0"><td colspan="5" class="px-4 py-16 text-center text-muted-foreground"><Wallet class="mx-auto mb-2 h-8 w-8 opacity-40" /> Xarajat yo'q</td></tr>
        </tbody>
        <tfoot v-if="visible.length" class="sticky bottom-0 border-t-2 bg-card text-sm font-semibold">
          <tr><td class="px-4 py-3" colspan="3">Jami: {{ visible.length }} ta</td><td class="px-4 py-3 text-right tabular-nums text-rose-600">{{ moneySum(total) }}</td><td></td></tr>
        </tfoot>
      </table>
    </div>

    <!-- Forma -->
    <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="max-h-[90vh] w-full max-w-md overflow-auto rounded-xl border bg-card p-5 shadow-xl">
        <div class="mb-4 flex items-center justify-between">
          <div class="text-lg font-semibold">{{ form.id ? 'Tahrirlash' : 'Yangi xarajat' }}</div>
          <button @click="showForm = false" class="rounded-md p-1.5 text-muted-foreground hover:bg-muted"><X class="h-4 w-4" /></button>
        </div>
        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="mb-1 block text-sm font-medium">Summa</label>
              <input v-model.number="form.amount" type="number" min="0" class="h-11 w-full rounded-md border bg-background px-3 text-lg font-semibold tabular-nums" />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium">Sana</label>
              <input v-model="form.date" type="date" :max="iso(new Date())" class="h-11 w-full rounded-md border bg-background px-3 text-sm tabular-nums" />
            </div>
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-medium">Toifa</label>
            <div class="flex flex-wrap gap-1.5">
              <button v-for="c in CATEGORIES" :key="c" type="button" @click="form.category = c"
                class="rounded-md border px-3 py-1.5 text-sm" :class="form.category === c ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'">{{ c }}</button>
            </div>
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium">Izoh (ixtiyoriy)</label>
            <input v-model="form.note" placeholder="Masalan: yanvar oyligi" class="h-10 w-full rounded-md border bg-background px-3 text-sm" />
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
