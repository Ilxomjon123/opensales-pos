<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Plus, UserCircle2, Search, ChevronRight, Pencil, Trash2, Eye, EyeOff, Users, HandCoins, Wallet } from 'lucide-vue-next'
import { listCustomers, saveCustomer, setCustomerActive, deleteCustomer, setCustomerBalance, type Customer } from '../lib/db'
import { moneySum, translitMatch } from '../lib/format'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'

const router = useRouter()
const customers = ref<Customer[]>([])
const search = ref('')
const balFilter = ref<'all' | 'debt' | 'credit'>('all')
const statusFilter = ref<'all' | 'active' | 'inactive'>('all')
const showForm = ref(false)
const editId = ref<number | undefined>()
const name = ref('')
const phone = ref('')
const balKind = ref<'debt' | 'credit' | 'none'>('none')
const balAmount = ref(0)

async function load() { customers.value = await listCustomers() }
onMounted(load)

const visible = computed(() => {
  let list = customers.value
  if (balFilter.value === 'debt') list = list.filter((c) => c.balance < 0)
  else if (balFilter.value === 'credit') list = list.filter((c) => c.balance > 0)
  if (statusFilter.value === 'active') list = list.filter((c) => c.is_active)
  else if (statusFilter.value === 'inactive') list = list.filter((c) => !c.is_active)
  if (search.value.trim()) list = list.filter((c) => translitMatch(c.name, search.value) || (c.phone ?? '').includes(search.value))
  return list
})

const stats = computed(() => {
  const real = customers.value.filter((c) => !c.is_walk_in)
  return {
    count: real.length,
    debtors: customers.value.filter((c) => c.balance < 0).length,
    debt: customers.value.reduce((s, c) => s + (c.balance < 0 ? -c.balance : 0), 0),
    credit: customers.value.reduce((s, c) => s + (c.balance > 0 ? c.balance : 0), 0),
  }
})
function pickBal(v: 'debt' | 'credit') { balFilter.value = balFilter.value === v ? 'all' : v }
function go(c: Customer) { router.push(`/customers/${c.id}`) }

function openNew() { editId.value = undefined; name.value = ''; phone.value = ''; balKind.value = 'none'; balAmount.value = 0; showForm.value = true }
function openEdit(c: Customer) { editId.value = c.id; name.value = c.name; phone.value = c.phone ?? ''; showForm.value = true }
async function save() {
  if (!name.value.trim()) return
  const newId = await saveCustomer(name.value.trim(), phone.value.trim() || null, editId.value)
  // Yangi mijozga boshlang'ich (tizimdan oldingi) saldo. Harakat yo'q → dastlabki = belgilangan saldo.
  if (!editId.value && balKind.value !== 'none' && balAmount.value > 0) {
    const target = balKind.value === 'debt' ? -Math.abs(balAmount.value) : Math.abs(balAmount.value)
    await setCustomerBalance(newId, target)
  }
  showForm.value = false
  await load()
  notify('Saqlandi', 'success')
}
async function toggle(c: Customer) {
  await setCustomerActive(c.id, !c.is_active)
  await load()
  notify(c.is_active ? 'Deaktiv qilindi' : 'Aktiv qilindi', 'success')
}
async function remove(c: Customer) {
  if (!(await confirmDialog(`"${c.name}" o'chirilsinmi?`, { danger: true }))) return
  try { await deleteCustomer(c.id); await load(); notify("Mijoz o'chirildi", 'success') }
  catch (e: any) { notify(e?.message ?? 'Xato', 'error') }
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <div>
        <h1 class="text-lg font-semibold">Mijozlar</h1>
        <p class="text-sm text-muted-foreground">{{ stats.count }} ta · jami qarz {{ moneySum(stats.debt) }}</p>
      </div>
      <button @click="openNew" class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"><Plus class="h-4 w-4" /> Yangi mijoz</button>
    </header>

    <!-- Stat kartalar -->
    <div class="grid grid-cols-2 gap-3 border-b px-6 py-4 lg:grid-cols-4">
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Users class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Mijozlar</div><div class="text-lg font-bold tabular-nums">{{ stats.count }}</div></div>
      </div>
      <button @click="pickBal('debt')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="balFilter === 'debt' ? 'border-rose-500 ring-1 ring-rose-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600"><HandCoins class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Qarzdorlar</div><div class="text-lg font-bold tabular-nums">{{ stats.debtors }}</div></div>
      </button>
      <button @click="pickBal('debt')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="balFilter === 'debt' ? 'border-rose-500 ring-1 ring-rose-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600"><Wallet class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Jami qarz</div><div class="text-lg font-bold tabular-nums text-rose-600">{{ moneySum(stats.debt) }}</div></div>
      </button>
      <button @click="pickBal('credit')" class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:shadow-sm" :class="balFilter === 'credit' ? 'border-emerald-500 ring-1 ring-emerald-500' : ''">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><Wallet class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">Haqdorlik</div><div class="text-lg font-bold tabular-nums text-emerald-600">{{ moneySum(stats.credit) }}</div></div>
      </button>
    </div>

    <!-- Filtrlar -->
    <div class="flex flex-wrap items-center gap-2 border-b px-6 py-3">
      <div class="relative min-w-48 flex-1">
        <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input v-model="search" placeholder="Ism yoki telefon…" class="h-9 w-full rounded-lg border bg-background pl-9 pr-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
      </div>
      <select v-model="balFilter" class="h-9 rounded-lg border bg-card px-3 text-sm">
        <option value="all">Barcha saldo</option>
        <option value="debt">Qarzdorlar</option>
        <option value="credit">Haqdorlar</option>
      </select>
      <select v-model="statusFilter" class="h-9 rounded-lg border bg-card px-3 text-sm">
        <option value="all">Hammasi</option>
        <option value="active">Aktiv</option>
        <option value="inactive">Deaktiv</option>
      </select>
    </div>

    <div class="flex-1 overflow-auto">
      <table class="w-full text-sm">
        <thead class="sticky top-0 z-10 border-b bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr><th class="px-4 py-3">Mijoz</th><th class="px-4 py-3">Telefon</th><th class="px-4 py-3 text-right">Saldo</th><th class="px-4 py-3">Holat</th><th class="px-4 py-3"></th></tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="c in visible" :key="c.id" class="cursor-pointer hover:bg-muted/40" :class="c.is_active ? '' : 'opacity-50'" @click="go(c)">
            <td class="px-4 py-3 font-medium">
              <div class="flex items-center gap-2.5">
                <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><UserCircle2 class="h-5 w-5" /></div>
                <span class="flex items-center gap-2">{{ c.name }}
                  <span v-if="c.is_walk_in" class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Anonim</span>
                  <span v-if="!c.is_active" class="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-rose-600 uppercase">Deaktiv</span>
                </span>
              </div>
            </td>
            <td class="px-4 py-3 text-muted-foreground">{{ c.phone ?? '—' }}</td>
            <td class="px-4 py-3 text-right">
              <div class="font-semibold tabular-nums" :class="c.balance < 0 ? 'text-rose-600' : c.balance > 0 ? 'text-emerald-600' : 'text-muted-foreground'">{{ c.balance < 0 ? '− ' + moneySum(-c.balance) : moneySum(c.balance) }}</div>
            </td>
            <td class="px-4 py-3"><span class="rounded-full px-2 py-0.5 text-xs" :class="c.balance < 0 ? 'bg-rose-500/15 text-rose-600' : c.balance > 0 ? 'bg-emerald-500/15 text-emerald-600' : 'bg-slate-500/15 text-slate-500'">{{ c.balance < 0 ? 'Qarzdor' : c.balance > 0 ? 'Haqdor' : 'Saldo 0' }}</span></td>
            <td class="px-4 py-3" @click.stop>
              <div class="flex items-center justify-end gap-0.5">
                <template v-if="!c.is_walk_in">
                  <button @click="openEdit(c)" title="Tahrirlash" class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil class="h-4 w-4" /></button>
                  <button @click="toggle(c)" :title="c.is_active ? 'Deaktiv qilish' : 'Aktiv qilish'" class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><component :is="c.is_active ? EyeOff : Eye" class="h-4 w-4" /></button>
                  <button @click="remove(c)" title="O'chirish" class="rounded p-1.5 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"><Trash2 class="h-4 w-4" /></button>
                </template>
                <ChevronRight class="h-4 w-4 text-muted-foreground/50" />
              </div>
            </td>
          </tr>
          <tr v-if="visible.length === 0"><td colspan="5" class="px-4 py-16 text-center text-muted-foreground"><UserCircle2 class="mx-auto mb-2 h-8 w-8 opacity-40" /> Mijoz topilmadi</td></tr>
        </tbody>
        <tfoot v-if="visible.length" class="sticky bottom-0 border-t-2 bg-card text-sm font-semibold">
          <tr>
            <td class="px-4 py-3" colspan="2">Jami: {{ visible.length }} ta</td>
            <td class="px-4 py-3 text-right tabular-nums text-rose-600">{{ moneySum(stats.debt) }}</td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-sm rounded-xl border bg-card p-5 shadow-xl">
        <div class="mb-4 text-lg font-semibold">{{ editId ? 'Mijozni tahrirlash' : 'Yangi mijoz' }}</div>
        <div class="space-y-3">
          <div><label class="mb-1 block text-sm font-medium">Ism</label><input v-model="name" autofocus class="h-10 w-full rounded-md border bg-background px-3 text-sm" @keyup.enter="save" /></div>
          <div><label class="mb-1 block text-sm font-medium">Telefon</label><input v-model="phone" placeholder="+998…" class="h-10 w-full rounded-md border bg-background px-3 text-sm" @keyup.enter="save" /></div>
          <div v-if="!editId">
            <label class="mb-1 block text-sm font-medium">Boshlang'ich saldo <span class="font-normal text-muted-foreground">(ixtiyoriy — tizimdan oldingi qarz/haqdorlik)</span></label>
            <div class="flex gap-2">
              <button type="button" @click="balKind = 'none'" class="h-9 flex-1 rounded-md border text-sm" :class="balKind === 'none' ? 'border-primary bg-primary/10 text-primary' : ''">Yo'q</button>
              <button type="button" @click="balKind = 'debt'" class="h-9 flex-1 rounded-md border text-sm" :class="balKind === 'debt' ? 'border-rose-500 bg-rose-500/10 text-rose-600' : ''">Qarzdor</button>
              <button type="button" @click="balKind = 'credit'" class="h-9 flex-1 rounded-md border text-sm" :class="balKind === 'credit' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600' : ''">Haqdor</button>
            </div>
            <input v-if="balKind !== 'none'" v-model.number="balAmount" type="number" min="0" placeholder="Summa"
              class="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm font-semibold tabular-nums" @keyup.enter="save" />
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
