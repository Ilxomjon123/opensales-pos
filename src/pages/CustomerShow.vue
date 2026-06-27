<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Receipt, HandCoins, Wallet, Scale, History, ChevronDown } from 'lucide-vue-next'
import { getCustomer, listSales, customerPayments, recordCustomerPayment, setCustomerBalance, type Customer, type Sale, type SaleItem, type CustomerPayment } from '../lib/db'
import { moneySum, formatDateTime } from '../lib/format'
import { notify } from '../lib/notify'

type SaleFull = Sale & { items: SaleItem[]; customer_name: string | null }

const route = useRoute()
const router = useRouter()
const id = Number(route.params.id)
const customer = ref<Customer | null>(null)
const sales = ref<SaleFull[]>([])
const payments = ref<CustomerPayment[]>([])
// Yoyilgan sotuvlar (tovarlarini ko'rsatish uchun)
const expanded = ref<Set<number>>(new Set())
function toggle(saleId?: number) {
  if (!saleId) return
  const s = new Set(expanded.value)
  s.has(saleId) ? s.delete(saleId) : s.add(saleId)
  expanded.value = s
}

const showPay = ref(false)
const payAmount = ref(0)
const payMethod = ref('cash')

// Saldoni belgilash (dastlabki saldo = belgilangan saldo − tizim ichidagi oldi-berdi)
const showBal = ref(false)
const balKind = ref<'debt' | 'credit' | 'none'>('debt')
const balAmount = ref(0)
const opening = computed(() => customer.value?.opening_balance ?? 0)
// Invariant: balance = opening_balance + movements → movements = balance − opening.
const movements = computed(() => (customer.value?.balance ?? 0) - opening.value)
const targetBalance = computed(() => balKind.value === 'debt' ? -Math.abs(balAmount.value) : balKind.value === 'credit' ? Math.abs(balAmount.value) : 0)
const previewOpening = computed(() => Math.round(targetBalance.value) - movements.value)

const statusLabels: Record<string, string> = { paid: "To'langan", partial: 'Qisman', debt: 'Qarz' }
const statusStyles: Record<string, string> = { paid: 'bg-emerald-500/15 text-emerald-600', partial: 'bg-amber-500/15 text-amber-600', debt: 'bg-rose-500/15 text-rose-600' }

// Ustunlar Sotuvlar bo'limidagidek: Summa · To'langan · Qarz.
type Ledger = { kind: 'sale' | 'payment' | 'opening'; date: string; label: string; total: number; paid: number; debt: number; status?: string; sale?: SaleFull }
const ledger = computed<Ledger[]>(() => {
  const rows: Ledger[] = []
  for (const s of sales.value) rows.push({ kind: 'sale', date: s.created_at, label: `Sotuv #${s.receipt_number}`, total: s.total, paid: s.paid_amount, debt: s.debt_amount, status: s.payment_status, sale: s })
  for (const p of payments.value) rows.push({ kind: 'payment', date: p.created_at, label: p.method === 'card' ? 'To\'lov (karta)' : 'To\'lov (naqd)', total: 0, paid: p.amount, debt: 0 })
  rows.sort((a, b) => (a.date < b.date ? 1 : -1))
  // Dastlabki saldo eng oxirgi (eng eski) qator — tizimdan oldingi qarz/haqdorlik.
  const op = opening.value
  if (op !== 0) rows.push({ kind: 'opening', date: '', label: 'Dastlabki saldo (tizimdan oldin)', total: 0, paid: op > 0 ? op : 0, debt: op < 0 ? -op : 0 })
  return rows
})
// Jami (footer) — sotuvlar bo'yicha
const tot = computed(() => ({
  total: sales.value.reduce((s, x) => s + x.total, 0),
  paid: payments.value.reduce((s, x) => s + x.amount, 0) + sales.value.reduce((s, x) => s + x.paid_amount, 0),
  debt: Math.max(0, -(customer.value?.balance ?? 0)),
}))

async function load() {
  customer.value = await getCustomer(id)
  ;[sales.value, payments.value] = await Promise.all([listSales({ customerId: id }), customerPayments(id)])
  payAmount.value = customer.value && customer.value.balance < 0 ? -customer.value.balance : 0
}
onMounted(load)

async function pay() {
  if (!payAmount.value || payAmount.value <= 0) return
  await recordCustomerPayment(id, payAmount.value, payMethod.value)
  showPay.value = false
  await load()
}

function openBal() {
  const b = customer.value?.balance ?? 0
  balKind.value = b < 0 ? 'debt' : b > 0 ? 'credit' : 'none'
  balAmount.value = Math.abs(b)
  showBal.value = true
}
async function saveBal() {
  await setCustomerBalance(id, targetBalance.value)
  showBal.value = false
  await load()
  notify('Saldo belgilandi', 'success')
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="page-header flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2 sm:gap-3">
        <button @click="router.back()" class="shrink-0 rounded-lg p-2 hover:bg-muted"><ArrowLeft class="h-5 w-5" /></button>
        <div class="min-w-0">
          <h1 class="truncate text-lg font-semibold">{{ customer?.name ?? '—' }}</h1>
          <p class="truncate text-sm text-muted-foreground">{{ customer?.phone ?? 'Telefon yo\'q' }}</p>
        </div>
      </div>
      <div v-if="customer && !customer.is_walk_in" class="flex shrink-0 items-center gap-2">
        <button @click="openBal" title="Saldoni belgilash" class="flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium hover:bg-muted sm:px-3.5">
          <Scale class="h-4 w-4" /> <span class="hidden sm:inline">Saldoni belgilash</span>
        </button>
        <button @click="showPay = true" title="To'lov qabul qilish" class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:px-3.5">
          <HandCoins class="h-4 w-4" /> <span class="hidden sm:inline">To'lov qabul qilish</span>
        </button>
      </div>
    </header>

    <div class="flex-1 space-y-5 overflow-auto p-4 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] sm:p-6 lg:pb-6">
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div class="rounded-xl border bg-card p-4">
          <div class="text-xs text-muted-foreground">Joriy saldo</div>
          <div class="mt-1 text-2xl font-bold tabular-nums" :class="(customer?.balance ?? 0) < 0 ? 'text-rose-600' : (customer?.balance ?? 0) > 0 ? 'text-emerald-600' : 'text-muted-foreground'">{{ (customer?.balance ?? 0) < 0 ? '− ' + moneySum(-(customer?.balance ?? 0)) : moneySum(customer?.balance ?? 0) }}</div>
          <div class="mt-0.5 text-xs text-muted-foreground">{{ (customer?.balance ?? 0) < 0 ? 'Qarzdor' : (customer?.balance ?? 0) > 0 ? 'Haqdor' : 'Qarzi yo\'q' }}</div>
          <div v-if="opening !== 0" class="mt-2 flex items-center gap-1.5 border-t pt-2 text-xs text-muted-foreground">
            <History class="h-3.5 w-3.5 shrink-0" />
            <span>Dastlabki: <span class="font-medium tabular-nums" :class="opening < 0 ? 'text-rose-600' : 'text-emerald-600'">{{ opening < 0 ? '−' + moneySum(-opening) : moneySum(opening) }}</span></span>
          </div>
        </div>
        <div class="rounded-xl border bg-card p-4"><div class="text-xs text-muted-foreground">Sotuvlar</div><div class="mt-1 text-2xl font-bold tabular-nums">{{ sales.length }}</div></div>
        <div class="rounded-xl border bg-card p-4"><div class="text-xs text-muted-foreground">Umumiy savdo</div><div class="mt-1 text-lg font-bold tabular-nums">{{ moneySum(sales.reduce((s, x) => s + x.total, 0)) }}</div></div>
        <div class="rounded-xl border bg-card p-4"><div class="text-xs text-muted-foreground">Qabul qilingan to'lov</div><div class="mt-1 text-lg font-bold tabular-nums text-emerald-600">{{ moneySum(payments.reduce((s, x) => s + x.amount, 0)) }}</div></div>
      </div>

      <div class="overflow-hidden rounded-xl border bg-card">
        <div class="border-b px-4 py-3 text-sm font-semibold">Oldi-berdilar</div>
        <!-- Mobil: kartalar ro'yxati -->
        <ul class="divide-y lg:hidden">
          <li v-for="(r, i) in ledger" :key="i">
            <div class="flex items-center gap-3 px-4 py-3" :class="r.kind === 'sale' ? 'cursor-pointer active:bg-muted/40' : ''" @click="r.kind === 'sale' && toggle(r.sale?.id)">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" :class="r.kind === 'payment' ? 'bg-emerald-500/10 text-emerald-600' : r.kind === 'opening' ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'">
                <component :is="r.kind === 'payment' ? Wallet : r.kind === 'opening' ? History : Receipt" class="h-4 w-4" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-sm font-medium">{{ r.label }}</span>
                  <span v-if="r.status" class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]" :class="statusStyles[r.status]">{{ statusLabels[r.status] ?? r.status }}</span>
                </div>
                <div class="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                  <span>{{ r.kind === 'opening' ? 'Tizimdan oldin' : formatDateTime(r.date) }}</span>
                  <span v-if="r.sale" class="text-muted-foreground/70">· {{ r.sale.items.length }} ta tovar</span>
                </div>
              </div>
              <div class="shrink-0 text-right">
                <div v-if="r.kind === 'sale'" class="font-semibold tabular-nums">{{ moneySum(r.total) }}</div>
                <div v-if="r.debt > 0" class="text-xs tabular-nums text-rose-500">qarz {{ moneySum(r.debt) }}</div>
                <div v-else-if="r.paid > 0" class="text-xs tabular-nums text-emerald-600">{{ r.kind === 'sale' ? "to'langan " : '' }}{{ moneySum(r.paid) }}</div>
              </div>
              <ChevronDown v-if="r.kind === 'sale'" class="h-4 w-4 shrink-0 text-muted-foreground transition-transform" :class="r.sale && expanded.has(r.sale.id) ? 'rotate-180' : ''" />
            </div>
            <!-- Yoyilgan: tovarlar + to'lov tafsiloti -->
            <div v-if="r.sale && expanded.has(r.sale.id)" class="border-t bg-muted/20 px-4 py-3">
              <ul class="space-y-1.5">
                <li v-for="it in r.sale.items" :key="it.id" class="flex items-baseline justify-between gap-2 text-sm">
                  <span class="min-w-0 flex-1 truncate">{{ it.product_name }}</span>
                  <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ it.qty }} {{ it.unit }} × {{ moneySum(it.price) }}</span>
                  <span class="w-24 shrink-0 text-right font-medium tabular-nums">{{ moneySum(it.subtotal) }}</span>
                </li>
              </ul>
              <div class="mt-2 space-y-0.5 border-t pt-2 text-xs">
                <div v-if="r.sale.discount > 0" class="flex justify-between text-muted-foreground"><span>Chegirma</span><span class="tabular-nums">− {{ moneySum(r.sale.discount) }}</span></div>
                <div class="flex justify-between font-semibold"><span>Jami</span><span class="tabular-nums">{{ moneySum(r.sale.total) }}</span></div>
                <div v-if="r.sale.paid_cash > 0" class="flex justify-between text-muted-foreground"><span>Naqd</span><span class="tabular-nums">{{ moneySum(r.sale.paid_cash) }}</span></div>
                <div v-if="r.sale.paid_card > 0" class="flex justify-between text-muted-foreground"><span>Karta</span><span class="tabular-nums">{{ moneySum(r.sale.paid_card) }}</span></div>
                <div v-if="r.sale.debt_amount > 0" class="flex justify-between font-medium text-rose-600"><span>Qarz</span><span class="tabular-nums">{{ moneySum(r.sale.debt_amount) }}</span></div>
              </div>
            </div>
          </li>
          <li v-if="ledger.length === 0" class="px-4 py-12 text-center text-muted-foreground">Hali oldi-berdi yo'q</li>
        </ul>
        <table class="hidden w-full text-sm lg:table">
          <thead class="border-b bg-muted/30 text-left text-xs tracking-wide text-muted-foreground uppercase">
            <tr><th class="px-4 py-2.5">Amal</th><th class="px-4 py-2.5">Vaqt</th><th class="px-4 py-2.5 text-right">Summa</th><th class="px-4 py-2.5 text-right">To'langan</th><th class="px-4 py-2.5 text-right">Qarz</th><th class="px-4 py-2.5">Holat</th></tr>
          </thead>
          <tbody class="divide-y">
            <template v-for="(r, i) in ledger" :key="i">
              <tr class="hover:bg-muted/40" :class="r.kind === 'sale' ? 'cursor-pointer' : ''" @click="r.kind === 'sale' && toggle(r.sale?.id)">
                <td class="px-4 py-2.5">
                  <span class="inline-flex items-center gap-1.5 font-medium" :class="r.kind === 'payment' ? 'text-emerald-600' : r.kind === 'opening' ? 'text-muted-foreground' : ''">
                    <ChevronDown v-if="r.kind === 'sale'" class="h-3.5 w-3.5 text-muted-foreground transition-transform" :class="r.sale && expanded.has(r.sale.id) ? 'rotate-180' : ''" />
                    <component v-else :is="r.kind === 'payment' ? Wallet : History" class="h-3.5 w-3.5" />
                    {{ r.label }}
                    <span v-if="r.sale" class="text-xs font-normal text-muted-foreground">· {{ r.sale.items.length }} ta tovar</span>
                  </span>
                </td>
                <td class="px-4 py-2.5 text-xs">{{ r.kind === 'opening' ? '—' : formatDateTime(r.date) }}</td>
                <td class="px-4 py-2.5 text-right font-medium tabular-nums" :class="r.total > 0 ? '' : 'text-muted-foreground'">{{ r.total > 0 ? moneySum(r.total) : '—' }}</td>
                <td class="px-4 py-2.5 text-right tabular-nums" :class="r.paid > 0 ? 'text-emerald-600' : 'text-muted-foreground'">{{ r.paid > 0 ? moneySum(r.paid) : '—' }}</td>
                <td class="px-4 py-2.5 text-right tabular-nums" :class="r.debt > 0 ? 'text-rose-500' : 'text-muted-foreground'">{{ r.debt > 0 ? moneySum(r.debt) : '—' }}</td>
                <td class="px-4 py-2.5"><span v-if="r.status" class="rounded-full px-2 py-0.5 text-xs" :class="statusStyles[r.status]">{{ statusLabels[r.status] ?? r.status }}</span></td>
              </tr>
              <!-- Yoyilgan: tovarlar -->
              <tr v-if="r.sale && expanded.has(r.sale.id)" class="bg-muted/20">
                <td colspan="6" class="px-4 pb-3">
                  <div class="overflow-hidden rounded-lg border bg-card">
                    <table class="w-full text-xs">
                      <thead class="bg-muted/40 text-left text-muted-foreground">
                        <tr><th class="px-3 py-1.5 font-medium">Tovar</th><th class="px-3 py-1.5 text-right font-medium">Soni</th><th class="px-3 py-1.5 text-right font-medium">Narx</th><th class="px-3 py-1.5 text-right font-medium">Summa</th></tr>
                      </thead>
                      <tbody class="divide-y">
                        <tr v-for="it in r.sale.items" :key="it.id">
                          <td class="px-3 py-1.5">{{ it.product_name }}</td>
                          <td class="px-3 py-1.5 text-right tabular-nums">{{ it.qty }} {{ it.unit }}</td>
                          <td class="px-3 py-1.5 text-right tabular-nums">{{ moneySum(it.price) }}</td>
                          <td class="px-3 py-1.5 text-right font-medium tabular-nums">{{ moneySum(it.subtotal) }}</td>
                        </tr>
                      </tbody>
                      <tfoot class="border-t bg-muted/20">
                        <tr v-if="r.sale.discount > 0" class="text-muted-foreground"><td colspan="3" class="px-3 py-1 text-right">Chegirma</td><td class="px-3 py-1 text-right tabular-nums">− {{ moneySum(r.sale.discount) }}</td></tr>
                        <tr class="font-semibold"><td colspan="3" class="px-3 py-1 text-right">Jami</td><td class="px-3 py-1 text-right tabular-nums">{{ moneySum(r.sale.total) }}</td></tr>
                        <tr v-if="r.sale.paid_cash > 0" class="text-muted-foreground"><td colspan="3" class="px-3 py-1 text-right">Naqd</td><td class="px-3 py-1 text-right tabular-nums">{{ moneySum(r.sale.paid_cash) }}</td></tr>
                        <tr v-if="r.sale.paid_card > 0" class="text-muted-foreground"><td colspan="3" class="px-3 py-1 text-right">Karta</td><td class="px-3 py-1 text-right tabular-nums">{{ moneySum(r.sale.paid_card) }}</td></tr>
                        <tr v-if="r.sale.debt_amount > 0" class="font-medium text-rose-600"><td colspan="3" class="px-3 py-1 text-right">Qarz</td><td class="px-3 py-1 text-right tabular-nums">{{ moneySum(r.sale.debt_amount) }}</td></tr>
                      </tfoot>
                    </table>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="ledger.length === 0"><td colspan="6" class="px-4 py-12 text-center text-muted-foreground">Hali oldi-berdi yo'q</td></tr>
          </tbody>
          <tfoot v-if="ledger.length" class="border-t-2 bg-card text-sm font-semibold">
            <tr>
              <td class="px-4 py-3" colspan="2">Jami</td>
              <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(tot.total) }}</td>
              <td class="px-4 py-3 text-right tabular-nums text-emerald-600">{{ moneySum(tot.paid) }}</td>
              <td class="px-4 py-3 text-right tabular-nums text-rose-600">{{ tot.debt > 0 ? moneySum(tot.debt) : '—' }}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <!-- To'lov modal -->
    <div v-if="showPay" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl border bg-card p-5 shadow-xl">
        <div class="mb-1 text-lg font-semibold">To'lov qabul qilish</div>
        <p class="mb-4 text-sm text-muted-foreground">{{ customer?.name }}</p>
        <label class="mb-1 block text-sm font-medium">Summa</label>
        <input v-model.number="payAmount" type="number" min="0" class="mb-3 h-11 w-full rounded-lg border bg-background px-3 text-lg font-semibold tabular-nums" />
        <div class="mb-4 flex gap-2">
          <button @click="payMethod = 'cash'" class="h-9 flex-1 rounded-md border text-sm" :class="payMethod === 'cash' ? 'border-primary bg-primary/10 text-primary' : ''">Naqd</button>
          <button @click="payMethod = 'card'" class="h-9 flex-1 rounded-md border text-sm" :class="payMethod === 'card' ? 'border-primary bg-primary/10 text-primary' : ''">Karta</button>
        </div>
        <div class="flex gap-2">
          <button @click="pay" class="h-10 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Qabul qilish</button>
          <button @click="showPay = false" class="h-10 rounded-md border px-4 text-sm hover:bg-muted">Bekor</button>
        </div>
      </div>
    </div>

    <!-- Saldoni belgilash modal -->
    <div v-if="showBal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl border bg-card p-5 shadow-xl">
        <div class="mb-1 text-lg font-semibold">Joriy saldoni belgilash</div>
        <p class="mb-4 text-sm text-muted-foreground">{{ customer?.name }}</p>

        <div class="mb-3 flex gap-2">
          <button @click="balKind = 'debt'" class="h-9 flex-1 rounded-md border text-sm" :class="balKind === 'debt' ? 'border-rose-500 bg-rose-500/10 text-rose-600' : ''">Qarzdor</button>
          <button @click="balKind = 'credit'" class="h-9 flex-1 rounded-md border text-sm" :class="balKind === 'credit' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600' : ''">Haqdor</button>
          <button @click="balKind = 'none'" class="h-9 flex-1 rounded-md border text-sm" :class="balKind === 'none' ? 'border-primary bg-primary/10 text-primary' : ''">Yo'q</button>
        </div>
        <label class="mb-1 block text-sm font-medium">Summa</label>
        <input v-model.number="balAmount" type="number" min="0" :disabled="balKind === 'none'"
          class="mb-3 h-11 w-full rounded-lg border bg-background px-3 text-lg font-semibold tabular-nums disabled:opacity-50" />

        <div class="mb-4 space-y-1 rounded-lg border bg-muted/40 p-3 text-xs">
          <div class="flex justify-between"><span class="text-muted-foreground">Tizim ichidagi oldi-berdi</span><span class="tabular-nums" :class="movements < 0 ? 'text-rose-600' : movements > 0 ? 'text-emerald-600' : ''">{{ movements < 0 ? '−' + moneySum(-movements) : moneySum(movements) }}</span></div>
          <div class="flex justify-between border-t pt-1 font-medium"><span>Dastlabki saldo (tizimdan oldin)</span><span class="tabular-nums" :class="previewOpening < 0 ? 'text-rose-600' : previewOpening > 0 ? 'text-emerald-600' : ''">{{ previewOpening < 0 ? '−' + moneySum(-previewOpening) : moneySum(previewOpening) }}</span></div>
        </div>

        <div class="flex gap-2">
          <button @click="saveBal" class="h-10 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Saqlash</button>
          <button @click="showBal = false" class="h-10 rounded-md border px-4 text-sm hover:bg-muted">Bekor</button>
        </div>
      </div>
    </div>
  </div>
</template>
