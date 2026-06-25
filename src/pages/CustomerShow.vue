<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Receipt, HandCoins, Wallet } from 'lucide-vue-next'
import { getCustomer, customerSales, customerPayments, recordCustomerPayment, type Customer, type Sale, type CustomerPayment } from '../lib/db'
import { moneySum, formatDateTime } from '../lib/format'

const route = useRoute()
const router = useRouter()
const id = Number(route.params.id)
const customer = ref<Customer | null>(null)
const sales = ref<Sale[]>([])
const payments = ref<CustomerPayment[]>([])

const showPay = ref(false)
const payAmount = ref(0)
const payMethod = ref('cash')

const statusLabels: Record<string, string> = { paid: "To'langan", partial: 'Qisman', debt: 'Qarz' }
const statusStyles: Record<string, string> = { paid: 'bg-emerald-500/15 text-emerald-600', partial: 'bg-amber-500/15 text-amber-600', debt: 'bg-rose-500/15 text-rose-600' }

type Ledger = { kind: 'sale' | 'payment'; date: string; label: string; debit: number; credit: number; status?: string }
const ledger = computed<Ledger[]>(() => {
  const rows: Ledger[] = []
  for (const s of sales.value) rows.push({ kind: 'sale', date: s.created_at, label: `Sotuv #${s.receipt_number}`, debit: s.debt_amount, credit: 0, status: s.payment_status })
  for (const p of payments.value) rows.push({ kind: 'payment', date: p.created_at, label: p.method === 'card' ? 'To\'lov (karta)' : 'To\'lov (naqd)', debit: 0, credit: p.amount })
  return rows.sort((a, b) => (a.date < b.date ? 1 : -1))
})

async function load() {
  customer.value = await getCustomer(id)
  ;[sales.value, payments.value] = await Promise.all([customerSales(id), customerPayments(id)])
  payAmount.value = customer.value && customer.value.balance < 0 ? -customer.value.balance : 0
}
onMounted(load)

async function pay() {
  if (!payAmount.value || payAmount.value <= 0) return
  await recordCustomerPayment(id, payAmount.value, payMethod.value)
  showPay.value = false
  await load()
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <div class="flex items-center gap-3">
        <button @click="router.back()" class="rounded-lg p-2 hover:bg-muted"><ArrowLeft class="h-5 w-5" /></button>
        <div>
          <h1 class="text-lg font-semibold">{{ customer?.name ?? '—' }}</h1>
          <p class="text-sm text-muted-foreground">{{ customer?.phone ?? 'Telefon yo\'q' }}</p>
        </div>
      </div>
      <button v-if="customer && !customer.is_walk_in" @click="showPay = true" class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
        <HandCoins class="h-4 w-4" /> To'lov qabul qilish
      </button>
    </header>

    <div class="flex-1 space-y-5 overflow-auto p-6">
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div class="rounded-xl border bg-card p-4">
          <div class="text-xs text-muted-foreground">Joriy saldo</div>
          <div class="mt-1 text-2xl font-bold tabular-nums" :class="(customer?.balance ?? 0) < 0 ? 'text-rose-600' : 'text-emerald-600'">{{ (customer?.balance ?? 0) < 0 ? '− ' + moneySum(-(customer?.balance ?? 0)) : moneySum(customer?.balance ?? 0) }}</div>
          <div class="mt-0.5 text-xs text-muted-foreground">{{ (customer?.balance ?? 0) < 0 ? 'Qarzdor' : 'Qarzi yo\'q' }}</div>
        </div>
        <div class="rounded-xl border bg-card p-4"><div class="text-xs text-muted-foreground">Sotuvlar</div><div class="mt-1 text-2xl font-bold tabular-nums">{{ sales.length }}</div></div>
        <div class="rounded-xl border bg-card p-4"><div class="text-xs text-muted-foreground">Umumiy savdo</div><div class="mt-1 text-lg font-bold tabular-nums">{{ moneySum(sales.reduce((s, x) => s + x.total, 0)) }}</div></div>
        <div class="rounded-xl border bg-card p-4"><div class="text-xs text-muted-foreground">Qabul qilingan to'lov</div><div class="mt-1 text-lg font-bold tabular-nums text-emerald-600">{{ moneySum(payments.reduce((s, x) => s + x.amount, 0)) }}</div></div>
      </div>

      <div class="overflow-hidden rounded-xl border bg-card">
        <div class="border-b px-4 py-3 text-sm font-semibold">Oldi-berdilar</div>
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/30 text-left text-xs tracking-wide text-muted-foreground uppercase">
            <tr><th class="px-4 py-2.5">Amal</th><th class="px-4 py-2.5">Vaqt</th><th class="px-4 py-2.5 text-right">Qarz (+)</th><th class="px-4 py-2.5 text-right">To'lov (−)</th><th class="px-4 py-2.5">Holat</th></tr>
          </thead>
          <tbody class="divide-y">
            <tr v-for="(r, i) in ledger" :key="i" class="hover:bg-muted/40">
              <td class="px-4 py-2.5">
                <span class="inline-flex items-center gap-1.5 font-medium" :class="r.kind === 'payment' ? 'text-emerald-600' : ''">
                  <component :is="r.kind === 'payment' ? Wallet : Receipt" class="h-3.5 w-3.5" />{{ r.label }}
                </span>
              </td>
              <td class="px-4 py-2.5 text-xs">{{ formatDateTime(r.date) }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums" :class="r.debit > 0 ? 'text-rose-500' : 'text-muted-foreground'">{{ r.debit > 0 ? moneySum(r.debit) : '—' }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums" :class="r.credit > 0 ? 'text-emerald-600' : 'text-muted-foreground'">{{ r.credit > 0 ? moneySum(r.credit) : '—' }}</td>
              <td class="px-4 py-2.5"><span v-if="r.status" class="rounded-full px-2 py-0.5 text-xs" :class="statusStyles[r.status]">{{ statusLabels[r.status] ?? r.status }}</span></td>
            </tr>
            <tr v-if="ledger.length === 0"><td colspan="5" class="px-4 py-12 text-center text-muted-foreground">Hali oldi-berdi yo'q</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- To'lov modal -->
    <div v-if="showPay" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-sm rounded-xl border bg-card p-5 shadow-xl">
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
  </div>
</template>
