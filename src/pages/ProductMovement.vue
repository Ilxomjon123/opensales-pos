<script setup lang="ts">
// Mahsulot harakati (Panda WMS kartochkasi): bitta mahsulotning kirim va chiqimlari sana
// tartibida, har hujjatdan KEYINGI qoldiq bilan. Davr harakati qatoridan, Mahsulotlar
// ro'yxatidan ochiladi.
//
// "Qoldiq" ustuni filtrga qaramaydi — butun tarixdan (lib/stock.ts productMoves): "faqat
// shu mijoz" tanlansa ham har qator o'sha hujjatdan keyin qancha qolganini aytadi. Davr
// kartochkalari ham filtrsiz — Davr harakati qatoriga aynan teng; filtrlangan qatorlar
// yig'indisi alohida satrda.
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ArrowLeft, ArrowDownUp, FileSpreadsheet, X } from 'lucide-vue-next'
import { db, listProducts, type Product } from '../lib/db'
import { productMoves, moveSummary, type ProductMove, type MoveKind } from '../lib/stock'
import { exportProductMoves } from '../lib/exports'
import { moneySum, money, formatDateTime, translitMatch } from '../lib/format'
import { fmtQty } from '../lib/returns'
import { notify } from '../lib/notify'
import { useRowCursor, storedRange, saveRange, todayIso } from '../lib/rowCursor'
import type { ExportFormat } from '../lib/xlsx'
import SearchableSelect from '../components/SearchableSelect.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

type Dir = '' | 'in' | 'out'
const DAY = /^\d{4}-\d{2}-\d{2}$/
const qs = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '')

const productId = computed(() => Number(route.params.id))
const product = ref<Product | null>(null)
const category = ref<string | null>(null)
const moves = ref<ProductMove[]>([])
const products = ref<Product[]>([])
const loading = ref(true)
const missing = ref(false)

const init = storedRange()
const from = ref(DAY.test(qs('from')) ? qs('from') : init.from)
const to = ref(DAY.test(qs('to')) ? qs('to') : init.to)
const dir = ref<Dir>(qs('dir') === 'in' || qs('dir') === 'out' ? (qs('dir') as Dir) : '')
const party = ref<string | null>(qs('party') || null)
const search = ref(qs('q'))
const newestFirst = ref(qs('sort') === 'desc')
const src = computed(() => qs('src'))

async function load() {
  const id = productId.value
  loading.value = true
  missing.value = false
  try {
    const d = await db()
    const p = (await d.select<(Product & { category: string | null })[]>(
      'SELECT p.*, c.name category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?', [id],
    ))[0]
    if (!p) { missing.value = true; product.value = null; moves.value = []; return }
    const ms = await productMoves(id, t('common.walkInCustomer'))
    if (id !== productId.value) return // boshqa mahsulotga o'tib ketildi
    product.value = p
    category.value = p.category
    moves.value = ms
    if (products.value.length === 0) products.value = await listProducts(false)
  } catch (e: any) {
    notify(e?.message ?? String(e), 'error')
  } finally {
    loading.value = false
  }
}
watch(productId, load, { immediate: true })

// Holat manzilda — orqaga qaytilganda va qayta yuklashda saqlanadi. Komponent mahsulotlar
// orasida qayta ishlatiladi (bir marshrut), shuning uchun manzil o'zgarsa (orqaga/oldinga)
// maydonlar ham undan yangilanadi; teng bo'lsa yozilmaydi — sikl yo'q.
watch(() => route.query, () => {
  if (DAY.test(qs('from')) && qs('from') !== from.value) from.value = qs('from')
  if (DAY.test(qs('to')) && qs('to') !== to.value) to.value = qs('to')
  const d: Dir = qs('dir') === 'in' || qs('dir') === 'out' ? (qs('dir') as Dir) : ''
  if (d !== dir.value) dir.value = d
  if ((qs('party') || null) !== party.value) party.value = qs('party') || null
  if (qs('q') !== search.value.trim()) search.value = qs('q')
  if ((qs('sort') === 'desc') !== newestFirst.value) newestFirst.value = qs('sort') === 'desc'
})
watch([from, to, dir, party, search, newestFirst], () => {
  if (from.value && to.value) saveRange(from.value, to.value)
  const q: Record<string, string> = { from: from.value, to: to.value }
  if (dir.value) q.dir = dir.value
  if (party.value) q.party = party.value
  if (search.value.trim()) q.q = search.value.trim()
  if (newestFirst.value) q.sort = 'desc'
  if (src.value) q.src = src.value
  router.replace({ query: q })
})

// ---------- Davr ----------
const firstDate = computed(() => moves.value[0]?.day ?? null)
const today = todayIso()
function wholeHistory() { from.value = firstDate.value ?? today; to.value = today }
const isWholeHistory = computed(() => firstDate.value !== null && from.value <= firstDate.value && to.value >= today)

// ---------- Turi va kontragent ----------
const DIRS = computed<{ value: Dir; label: string }[]>(() => [
  { value: '', label: t('movement.all') },
  { value: 'in', label: t('movement.dirIn') },
  { value: 'out', label: t('movement.dirOut') },
])
const inDir = (m: ProductMove, d: Dir) => !d || (d === 'in' ? m.delta > 0 : m.delta < 0)

// Kontragentlar — katalogdagi hammasi emas, faqat shu mahsulot bilan ishlaganlari; avval
// ta'minotchilar, keyin mijozlar. Turi tanlansa — faqat o'sha tomondagilar.
const partyItems = computed(() => {
  const seen = new Map<string, { value: string; label: string; supplier: boolean }>()
  for (const m of moves.value) {
    if (!m.party_key || !m.party || !inDir(m, dir.value) || seen.has(m.party_key)) continue
    seen.set(m.party_key, { value: m.party_key, label: m.party, supplier: m.party_key.startsWith('s:') })
  }
  return [...seen.values()]
    .sort((a, b) => Number(b.supplier) - Number(a.supplier) || a.label.localeCompare(b.label))
    .map((p) => ({ value: p.value, label: `${p.label} · ${p.supplier ? t('movement.supplierHint') : t('movement.customerHint')}` }))
})
// Tanlangan kontragent yangi turga to'g'ri kelmasa — olib tashlanadi (bo'sh ro'yxat bermasin).
watch(dir, () => {
  if (party.value && !partyItems.value.some((p) => p.value === party.value)) party.value = null
})

const narrowed = computed(() => !!dir.value || !!party.value || !!search.value.trim())
function clearFilters() { dir.value = ''; party.value = null; search.value = '' }

// ---------- Boshqa mahsulot ----------
const productItems = computed(() => products.value.map((p) => ({ value: p.id, label: p.barcode ? `${p.name} · ${p.barcode}` : p.name })))
const otherProduct = ref<number | null>(null)
// Davr, turi, tartib va manba saqlanadi; kontragent va hujjat raqami — shu mahsulotniki edi.
// Tarixga yoziladi: "orqaga" oldingi mahsulotga qaytaradi.
watch(otherProduct, (id) => {
  if (!id || id === productId.value) { otherProduct.value = null; return }
  const q: Record<string, string> = { from: from.value, to: to.value }
  if (dir.value) q.dir = dir.value
  if (newestFirst.value) q.sort = 'desc'
  if (src.value) q.src = src.value
  party.value = null
  search.value = ''
  otherProduct.value = null
  router.push({ path: `/movement/${id}`, query: q })
})

// ---------- Jadval ----------
const summary = computed(() => moveSummary(moves.value, from.value, to.value, product.value?.stock ?? 0))
const filtered = computed(() => {
  const q = search.value.trim()
  const list = moves.value.filter((m) =>
    m.day >= from.value && m.day <= to.value && inDir(m, dir.value) &&
    (!party.value || m.party_key === party.value) && (!q || translitMatch(m.number, q)))
  return newestFirst.value ? [...list].reverse() : list
})
const totals = computed(() => {
  if (!narrowed.value) return null
  const ins = filtered.value.filter((m) => m.delta > 0)
  const outs = filtered.value.filter((m) => m.delta < 0)
  return {
    count: filtered.value.length,
    income: ins.reduce((s, m) => s + m.delta, 0),
    incomeAmount: ins.reduce((s, m) => s + (m.amount ?? 0), 0),
    outcome: -outs.reduce((s, m) => s + m.delta, 0),
    outcomeAmount: outs.reduce((s, m) => s + (m.amount ?? 0), 0),
  }
})
// Jadval boshidagi/oxiridagi qoldiq satri: o'sishda davr boshi tepada, kamayishda teskari.
const topEdge = computed(() => newestFirst.value
  ? { label: t('movement.edgeEnd'), value: summary.value.closing }
  : { label: t('movement.edgeStart'), value: summary.value.opening })
const bottomEdge = computed(() => newestFirst.value
  ? { label: t('movement.edgeStart'), value: summary.value.opening }
  : { label: t('movement.edgeEnd'), value: summary.value.closing })

// Kirim — yashil, chiqim — qizil: rang chap chiziqda, och fonda va sonda (Panda).
const tone = (m: ProductMove) => (m.delta > 0
  ? { row: 'bg-emerald-500/5 shadow-[inset_3px_0_0_var(--color-emerald-500)] hover:bg-emerald-500/10', badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' }
  : { row: 'bg-rose-500/5 shadow-[inset_3px_0_0_var(--color-rose-500)] hover:bg-rose-500/10', badge: 'bg-rose-500/15 text-rose-700 dark:text-rose-400' })
const kindLabel = (m: ProductMove) => t(`movement.kind.${m.kind}`)

// Hujjatni ochish: o'sha bo'lim, qidiruvda hujjat raqami. Tuzatishning hujjati yo'q —
// mahsulotning o'zi (kartasida qoldiq o'zgartirilgan).
const DOC_PAGE: Record<MoveKind, string> = { receipt: '/receipts', sale: '/sales', return: '/returns', adjust: '/products' }
function openDoc(key: string) {
  const m = moves.value.find((x) => x.key === key)
  if (!m) return
  router.push({ path: DOC_PAGE[m.kind], query: { q: m.kind === 'adjust' ? (product.value?.name ?? '') : m.number } })
}
const tableRef = ref<HTMLElement | null>(null)
const cursor = useRowCursor(() => filtered.value.map((m) => m.key), tableRef, openDoc)

// ---------- Sarlavha ----------
const back = computed(() => {
  if (src.value === 'movement') return { label: t('movement.title'), to: { path: '/movement', query: { from: from.value, to: to.value } } }
  if (src.value === 'products') return { label: t('app.navProducts'), to: { path: '/products' } }
  return null
})
const onHandValue = computed(() => (product.value ? product.value.stock * product.value.cost_price : 0))

const exporting = ref(false)
async function doExport(format: ExportFormat) {
  if (!product.value || exporting.value) return
  exporting.value = true
  try {
    await exportProductMoves(format, {
      product: { id: product.value.id, name: product.value.name, unit: product.value.unit, barcode: product.value.barcode },
      from: from.value,
      to: to.value,
      summary: summary.value,
      rows: filtered.value,
      kindLabel,
      filter: {
        direction: dir.value ? DIRS.value.find((d) => d.value === dir.value)?.label : undefined,
        party: party.value ? moves.value.find((m) => m.party_key === party.value)?.party ?? undefined : undefined,
        search: search.value.trim() || undefined,
      },
    })
    notify(t('exports.saved'), 'success')
  } catch (e: any) { notify(t('exports.failed', { error: e?.message ?? e }), 'error') }
  finally { exporting.value = false }
}
const dateOnly = (iso: string) => iso.split('-').reverse().join('.')
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="page-header flex items-center justify-between gap-2">
      <div class="min-w-0">
        <h1 class="truncate text-lg font-semibold" :title="product?.name">{{ product?.name ?? $t('movement.cardTitle') }}</h1>
        <p class="truncate text-sm text-muted-foreground">{{ $t('movement.cardSubtitle') }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <RouterLink v-if="back" :to="back.to" class="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground">
          <ArrowLeft class="h-4 w-4" /> <span class="hidden sm:inline">{{ back.label }}</span>
        </RouterLink>
        <button @click="doExport('xlsx')" :disabled="!product || exporting" class="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition hover:bg-muted disabled:opacity-50">
          <FileSpreadsheet class="h-4 w-4 text-emerald-600" /> Excel
        </button>
        <button @click="doExport('csv')" :disabled="!product || exporting" class="h-9 rounded-lg px-2.5 text-sm text-muted-foreground transition hover:bg-muted disabled:opacity-50">CSV</button>
      </div>
    </header>

    <div v-if="missing" class="flex-1 px-4 py-16 text-center text-muted-foreground">{{ $t('movement.notFound') }}</div>

    <div v-else ref="tableRef" class="flex-1 space-y-3 overflow-auto px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] sm:px-6 sm:py-4 lg:pb-6">
      <!-- Mahsulot: kod, birlik, narx, hozirgi qoldiq; boshqasiga o'tish -->
      <section v-if="product" class="flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-card p-4">
        <div class="min-w-0 space-y-1 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <span v-if="product.barcode" class="font-mono text-xs text-muted-foreground tabular-nums">{{ $t('movement.code', { code: product.barcode }) }}</span>
            <span v-if="!product.is_active" class="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-rose-600 uppercase">{{ $t('movement.inactive') }}</span>
            <span v-if="category" class="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{{ category }}</span>
          </div>
          <p class="text-muted-foreground">{{ $t('movement.priceNote', { unit: product.unit, price: moneySum(product.price), cost: moneySum(product.cost_price) }) }}</p>
          <p>
            {{ $t('movement.onHand') }}
            <span class="font-semibold tabular-nums" :class="product.stock < 0 ? 'text-rose-600' : ''">{{ fmtQty(product.stock) }} {{ product.unit }}</span>
            <span class="text-muted-foreground tabular-nums"> · {{ moneySum(onHandValue) }}</span>
          </p>
        </div>
        <div class="w-full sm:w-80">
          <SearchableSelect v-model="otherProduct" :items="productItems" :placeholder="$t('movement.otherProduct')" :search-placeholder="$t('movement.productSearch')" />
        </div>
      </section>

      <!-- Filtrlar -->
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex w-full items-center gap-1 sm:w-auto">
          <input v-model="from" type="date" :aria-label="$t('movement.from')" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:w-36 sm:flex-none" />
          <span class="text-muted-foreground">—</span>
          <input v-model="to" type="date" :aria-label="$t('movement.to')" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:w-36 sm:flex-none" />
        </div>
        <button v-if="firstDate" type="button" @click="wholeHistory" :title="$t('movement.wholeHistoryHint')"
          class="h-9 rounded-md border px-3 text-sm" :class="isWholeHistory ? 'bg-foreground text-background' : 'hover:bg-muted'">{{ $t('movement.wholeHistory') }}</button>
        <div class="flex gap-1">
          <button v-for="d in DIRS" :key="d.value" type="button" @click="dir = d.value"
            class="h-9 rounded-md border px-3 text-sm" :class="dir === d.value ? 'bg-foreground text-background' : 'hover:bg-muted'">{{ d.label }}</button>
        </div>
        <div class="w-full sm:w-60">
          <SearchableSelect v-model="party" :items="partyItems" clearable
            :placeholder="$t('movement.allParties')" :search-placeholder="$t('movement.partySearch')" :empty-text="$t('movement.partyEmpty')" />
        </div>
        <input v-model="search" :placeholder="$t('movement.docSearch')" class="h-9 w-full rounded-md border bg-background px-3 text-sm sm:w-44" />
        <button type="button" @click="newestFirst = !newestFirst" :title="newestFirst ? $t('movement.sortHintDesc') : $t('movement.sortHintAsc')"
          class="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-muted">
          <ArrowDownUp class="h-4 w-4" /> {{ newestFirst ? $t('movement.newestFirst') : $t('movement.oldestFirst') }}
        </button>
        <button v-if="narrowed" type="button" @click="clearFilters" class="inline-flex h-9 items-center gap-1 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted">
          <X class="h-4 w-4" /> {{ $t('movement.clear') }}
        </button>
      </div>

      <!-- Davr: Davr harakati qatoriga teng (filtrsiz) -->
      <section v-if="product" class="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <div class="rounded-xl border bg-card p-3">
          <p class="text-xs text-muted-foreground">{{ $t('movement.atStart', { date: dateOnly(from) }) }}</p>
          <p class="mt-1 text-lg font-semibold tabular-nums" :class="summary.opening < 0 ? 'text-rose-600' : ''">{{ fmtQty(summary.opening) }} <span class="text-xs font-normal text-muted-foreground">{{ product.unit }}</span></p>
        </div>
        <div class="rounded-xl border border-l-[3px] border-l-emerald-500 bg-card p-3">
          <p class="text-xs text-muted-foreground">{{ $t('movement.inCard', { count: summary.income_count }) }}</p>
          <p class="mt-1 text-lg font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{{ summary.income > 0 ? '+' : '' }}{{ fmtQty(summary.income) }} <span class="text-xs font-normal text-muted-foreground">{{ product.unit }}</span></p>
          <p class="text-xs text-muted-foreground tabular-nums">{{ moneySum(summary.income_amount) }}</p>
        </div>
        <div class="rounded-xl border border-l-[3px] border-l-rose-500 bg-card p-3">
          <p class="text-xs text-muted-foreground">{{ $t('movement.outCard', { count: summary.outcome_count }) }}</p>
          <p class="mt-1 text-lg font-semibold tabular-nums text-rose-700 dark:text-rose-400">{{ summary.outcome > 0 ? '−' : '' }}{{ fmtQty(summary.outcome) }} <span class="text-xs font-normal text-muted-foreground">{{ product.unit }}</span></p>
          <p class="text-xs text-muted-foreground tabular-nums">{{ moneySum(summary.outcome_amount) }}</p>
        </div>
        <div class="rounded-xl border bg-card p-3">
          <p class="text-xs text-muted-foreground">{{ $t('movement.atEnd', { date: dateOnly(to) }) }}</p>
          <p class="mt-1 text-lg font-semibold tabular-nums" :class="summary.closing < 0 ? 'text-rose-600' : ''">{{ fmtQty(summary.closing) }} <span class="text-xs font-normal text-muted-foreground">{{ product.unit }}</span></p>
        </div>
      </section>

      <p v-if="totals" class="rounded-md border border-dashed px-3 py-2 text-sm">
        {{ $t('movement.filtered', { count: totals.count }) }}
        <template v-if="totals.income > 0"> · {{ $t('movement.dirIn').toLowerCase() }}
          <span class="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">+{{ fmtQty(totals.income) }} {{ product?.unit }}</span>
          <span class="text-muted-foreground tabular-nums"> ({{ moneySum(totals.incomeAmount) }})</span>
        </template>
        <template v-if="totals.outcome > 0"> · {{ $t('movement.dirOut').toLowerCase() }}
          <span class="font-medium tabular-nums text-rose-700 dark:text-rose-400">−{{ fmtQty(totals.outcome) }} {{ product?.unit }}</span>
          <span class="text-muted-foreground tabular-nums"> ({{ moneySum(totals.outcomeAmount) }})</span>
        </template>
      </p>

      <div v-if="product" class="overflow-x-auto rounded-xl border">
        <table class="w-full min-w-[52rem] text-sm">
          <thead class="bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th class="px-4 py-2.5">{{ $t('movement.colDate') }}</th>
              <th class="px-4 py-2.5">{{ $t('movement.colDoc') }}</th>
              <th class="px-4 py-2.5">{{ $t('movement.colParty') }}</th>
              <th class="px-4 py-2.5 text-right">{{ $t('movement.colIn') }}</th>
              <th class="px-4 py-2.5 text-right">{{ $t('movement.colOut') }}</th>
              <th class="px-4 py-2.5 text-right" :title="$t('movement.colBalanceHint')">{{ $t('movement.colBalance') }}</th>
              <th class="px-4 py-2.5 text-right" :title="$t('movement.colPriceHint')">{{ $t('movement.colPrice') }}</th>
              <th class="px-4 py-2.5 text-right">{{ $t('movement.colSum') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr class="bg-muted/30">
              <td class="px-4 py-2 text-muted-foreground" colspan="5">{{ topEdge.label }}</td>
              <td class="px-4 py-2 text-right font-medium tabular-nums" :class="topEdge.value < 0 ? 'text-rose-600' : ''">{{ fmtQty(topEdge.value) }}</td>
              <td colspan="2"></td>
            </tr>
            <tr v-if="!loading && filtered.length === 0">
              <td class="px-4 py-6 text-center text-muted-foreground" colspan="8">{{ narrowed ? $t('movement.noRowsFiltered') : $t('movement.noRows') }}</td>
            </tr>
            <tr v-for="m in filtered" :key="m.key" :data-row-key="m.key" :aria-current="cursor.isSelected(m.key) ? 'true' : undefined"
              class="cursor-pointer scroll-my-2 transition-colors"
              :class="cursor.isSelected(m.key) ? 'bg-sky-500/15 shadow-[inset_3px_0_0_var(--color-sky-500)]' : tone(m).row"
              @click="cursor.select(m.key)" @dblclick="openDoc(m.key)">
              <td class="px-4 py-2 whitespace-nowrap tabular-nums">{{ formatDateTime(m.at) }}</td>
              <td class="px-4 py-2">
                <button type="button" @click.stop="openDoc(m.key)" class="font-medium whitespace-nowrap hover:underline">{{ m.number }}</button>
                <span class="ml-1.5 rounded px-1.5 py-0.5 text-xs font-medium" :class="tone(m).badge">{{ kindLabel(m) }}</span>
                <span v-if="m.comment" class="block max-w-xs truncate text-xs text-muted-foreground" :title="m.comment">{{ m.comment }}</span>
              </td>
              <td class="px-4 py-2">{{ m.party ?? '—' }}</td>
              <td class="px-4 py-2 text-right font-medium tabular-nums text-emerald-700 dark:text-emerald-400">{{ m.delta > 0 ? fmtQty(m.delta) : '' }}</td>
              <td class="px-4 py-2 text-right font-medium tabular-nums text-rose-700 dark:text-rose-400">{{ m.delta < 0 ? fmtQty(-m.delta) : '' }}</td>
              <td class="px-4 py-2 text-right font-medium tabular-nums" :class="m.balance < 0 ? 'text-rose-600' : ''">{{ fmtQty(m.balance) }}</td>
              <td class="px-4 py-2 text-right tabular-nums text-muted-foreground">{{ m.price == null ? '' : money(m.price) }}</td>
              <td class="px-4 py-2 text-right tabular-nums">{{ m.amount == null ? '' : money(m.amount) }}</td>
            </tr>
            <tr class="bg-muted/30">
              <td class="px-4 py-2 text-muted-foreground" colspan="5">{{ bottomEdge.label }}</td>
              <td class="px-4 py-2 text-right font-medium tabular-nums" :class="bottomEdge.value < 0 ? 'text-rose-600' : ''">{{ fmtQty(bottomEdge.value) }}</td>
              <td colspan="2"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="filtered.length" class="text-xs text-muted-foreground">
        {{ $t('movement.hintClick') }}
        <kbd class="rounded border px-1 font-sans">↑</kbd> <kbd class="rounded border px-1 font-sans">↓</kbd> {{ $t('movement.hintArrows') }}
        <kbd class="rounded border px-1 font-sans">PgUp</kbd> <kbd class="rounded border px-1 font-sans">PgDn</kbd> {{ $t('movement.hintPage') }}
        <kbd class="rounded border px-1 font-sans">Esc</kbd> {{ $t('movement.hintEsc') }}
        <kbd class="rounded border px-1 font-sans">Enter</kbd> {{ $t('movement.hintEnter') }}
      </p>
      <p class="text-xs text-muted-foreground">{{ $t('movement.footnote') }}</p>
    </div>
  </div>
</template>
