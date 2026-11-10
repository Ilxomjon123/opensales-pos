<script setup lang="ts">
// Davr harakati (Panda WMS bilan bir xil): har mahsulot uchun boshlang'ich qoldiq, kirim,
// chiqim va oxirgi qoldiq. Qatorni bosing — shu davrdagi hujjatlari (Mahsulot harakati).
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ArrowLeftRight, Search, FileSpreadsheet, Calendar, Boxes, Coins, Activity, ChevronRight } from 'lucide-vue-next'
import { stockMovementReport, type MovementRow } from '../lib/stock'
import { exportMovement } from '../lib/exports'
import { moneySum, translitMatch } from '../lib/format'
import { fmtQty } from '../lib/returns'
import { notify } from '../lib/notify'
import { useRowCursor, storedRange, saveRange } from '../lib/rowCursor'
import { useWide } from '../lib/useWide'
import { scrollRoot } from '../lib/scroll'
import type { ExportFormat } from '../lib/xlsx'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const DAY = /^\d{4}-\d{2}-\d{2}$/
const init = storedRange()
const from = ref(typeof route.query.from === 'string' && DAY.test(route.query.from) ? route.query.from : init.from)
const to = ref(typeof route.query.to === 'string' && DAY.test(route.query.to) ? route.query.to : init.to)
const search = ref('')
const rows = ref<MovementRow[]>([])
const loading = ref(true)

async function load() {
  if (!from.value || !to.value) return
  loading.value = true
  try { rows.value = await stockMovementReport(from.value, to.value) }
  catch (e: any) { notify(e?.message ?? String(e), 'error'); rows.value = [] }
  finally { loading.value = false }
}
onMounted(load)
watch([from, to], ([f, tt]) => {
  if (!f || !tt) return
  saveRange(f, tt)
  router.replace({ query: { ...route.query, from: f, to: tt } })
  load()
})

const visible = computed(() => {
  const q = search.value.trim()
  return q ? rows.value.filter((r) => translitMatch(r.name, q) || translitMatch(r.category ?? '', q)) : rows.value
})
const stats = computed(() => ({
  count: visible.value.length,
  moved: visible.value.filter((r) => r.income || r.outcome).length,
  value: visible.value.reduce((s, r) => s + r.closing * r.cost_price, 0),
}))

// Mahsulot harakati — aynan shu davr: kartochka yig'indisi shu qatorga teng.
function open(productId: number) {
  router.push({ path: `/movement/${productId}`, query: { from: from.value, to: to.value, src: 'movement' } })
}

const tableRef = ref<HTMLElement | null>(null)
const wide = useWide()

// Telefon ro'yxati bo'laklab chiziladi (400+ tovar birdan — sahifa ochilishi qotardi).
const PAGE = 40
const shown = ref(PAGE)
watch(visible, () => { shown.value = PAGE })
const shownRows = computed(() => visible.value.slice(0, shown.value))
const listEnd = ref<HTMLElement | null>(null)
let listObserver: IntersectionObserver | null = null
watch(listEnd, (el) => {
  listObserver?.disconnect()
  if (!el) return
  listObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && shown.value < visible.value.length) shown.value += PAGE
  }, { root: scrollRoot(el), rootMargin: '600px' })
  listObserver.observe(el)
})
onBeforeUnmount(() => listObserver?.disconnect())
const cursor = useRowCursor(() => visible.value.map((r) => r.product_id), tableRef, open)

const exporting = ref(false)
async function doExport(format: ExportFormat) {
  if (exporting.value || visible.value.length === 0) return
  exporting.value = true
  try { await exportMovement(format, visible.value, from.value, to.value); notify(t('exports.saved'), 'success') }
  catch (e: any) { notify(t('exports.failed', { error: e?.message ?? e }), 'error') }
  finally { exporting.value = false }
}
</script>

<template>
  <div class="os-page flex h-full flex-col overflow-hidden">
    <header class="page-header flex items-center justify-between gap-2">
      <div class="min-w-0">
        <h1 class="text-lg font-semibold">{{ $t('movement.title') }}</h1>
        <p class="truncate text-sm text-muted-foreground">{{ $t('movement.subtitle') }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <button @click="doExport('xlsx')" :disabled="exporting || visible.length === 0" class="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition hover:bg-muted disabled:opacity-50">
          <FileSpreadsheet class="h-4 w-4 text-emerald-600" /> Excel
        </button>
        <button @click="doExport('csv')" :disabled="exporting || visible.length === 0" class="h-9 rounded-lg px-2.5 text-sm text-muted-foreground transition hover:bg-muted disabled:opacity-50">CSV</button>
      </div>
    </header>

    <div class="os-stats grid grid-cols-2 gap-2.5 border-b px-4 py-3 sm:gap-3 sm:px-6 sm:py-4 lg:grid-cols-3">
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Boxes class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('movement.statProducts') }}</div><div class="text-lg font-bold tabular-nums">{{ stats.count }}</div></div>
      </div>
      <div class="flex items-center gap-3 rounded-xl border bg-card p-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600"><Activity class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('movement.statMoved') }}</div><div class="text-lg font-bold tabular-nums">{{ stats.moved }}</div></div>
      </div>
      <div class="col-span-2 flex items-center gap-3 rounded-xl border bg-card p-3 lg:col-span-1">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><Coins class="h-4.5 w-4.5" /></div>
        <div><div class="text-xs text-muted-foreground">{{ $t('movement.statValue') }}</div><div class="text-lg font-bold tabular-nums">{{ moneySum(stats.value) }}</div></div>
      </div>
    </div>

    <div class="os-filters flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6">
      <div class="flex w-full items-center gap-2 sm:w-auto">
        <Calendar class="h-4 w-4 shrink-0 text-muted-foreground" />
        <label class="text-sm text-muted-foreground" for="mv-from">{{ $t('movement.from') }}</label>
        <input id="mv-from" v-model="from" type="date" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:flex-none" />
        <label class="text-sm text-muted-foreground" for="mv-to">{{ $t('movement.to') }}</label>
        <input id="mv-to" v-model="to" type="date" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:flex-none" />
      </div>
      <div class="relative w-full sm:ml-auto sm:w-64">
        <Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input v-model="search" :placeholder="$t('movement.searchPlaceholder')" class="h-9 w-full rounded-md border bg-background pr-2 pl-9 text-sm" />
      </div>
    </div>

    <div ref="tableRef" class="os-scroll flex-1 overflow-auto pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-0">
      <div v-if="!loading && visible.length === 0" class="px-4 py-16 text-center text-muted-foreground">
        <ArrowLeftRight class="mx-auto mb-2 h-8 w-8 opacity-40" /> {{ $t('movement.empty') }}
      </div>
      <template v-else>
      <!-- Telefon: kartalar ro'yxati (jadval 640px, ekranga sig'maydi). -->
      <ul v-if="!wide" class="os-list divide-y lg:hidden">
        <li v-for="r in shownRows" :key="r.product_id" :class="r.is_active ? '' : 'opacity-60'">
          <RouterLink :to="{ path: `/movement/${r.product_id}`, query: { from, to, src: 'movement' } }" class="flex items-center gap-3 px-4 py-3 active:bg-muted/40">
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ r.name }}</div>
              <div class="mt-0.5 flex flex-wrap gap-x-2.5 text-xs tabular-nums text-muted-foreground">
                <span :class="r.opening < 0 ? 'text-rose-600' : ''">{{ $t('movement.colOpening') }} {{ fmtQty(r.opening) }}</span>
                <span :class="r.income ? 'text-emerald-600' : ''">+{{ fmtQty(r.income) }}</span>
                <span :class="r.outcome ? 'text-rose-600' : ''">−{{ fmtQty(r.outcome) }}</span>
              </div>
            </div>
            <div class="shrink-0 text-right font-semibold tabular-nums" :class="r.closing < 0 ? 'text-rose-600' : ''">{{ fmtQty(r.closing) }} <span class="text-xs font-normal text-muted-foreground">{{ r.unit }}</span></div>
            <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground/60" />
          </RouterLink>
        </li>
        <li v-if="shown < visible.length" ref="listEnd" class="h-px" aria-hidden="true" />
        <li class="flex justify-between bg-muted/40 px-4 py-3 text-sm font-semibold"><span>{{ $t('movement.totalCount', { count: visible.length }) }}</span><span class="tabular-nums">{{ moneySum(stats.value) }}</span></li>
      </ul>
      <table v-if="wide" class="hidden w-full min-w-[40rem] text-sm lg:table">
        <thead class="sticky top-0 z-10 border-b bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr>
            <th class="px-4 py-3">{{ $t('movement.colProduct') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('movement.colOpening') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('movement.colIn') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('movement.colOut') }}</th>
            <th class="px-4 py-3 text-right">{{ $t('movement.colClosing') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <!-- Butun qator bosiladi — Mahsulot harakati shu davr uchun. Bitta bosish belgilaydi
               (sverka), ikki marta yoki Enter — ochadi; nom esa to'g'ridan havola. -->
          <tr v-for="r in visible" :key="r.product_id" :data-row-key="r.product_id"
            class="cursor-pointer scroll-my-2 transition-colors"
            :class="[cursor.isSelected(r.product_id) ? 'bg-sky-500/15 shadow-[inset_3px_0_0_var(--color-sky-500)]' : 'hover:bg-muted/40', r.is_active ? '' : 'opacity-60']"
            :title="$t('movement.rowTitle')"
            @click="cursor.select(r.product_id)" @dblclick="open(r.product_id)">
            <td class="px-4 py-2.5">
              <RouterLink :to="{ path: `/movement/${r.product_id}`, query: { from, to, src: 'movement' } }" @click.stop class="font-medium hover:underline">{{ r.name }}</RouterLink>
              <span class="block text-xs text-muted-foreground">{{ $t('movement.unitNote', { unit: r.unit }) }}<template v-if="r.category"> · {{ r.category }}</template></span>
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums text-muted-foreground" :class="r.opening < 0 ? '!text-rose-600' : ''">{{ fmtQty(r.opening) }}</td>
            <td class="px-4 py-2.5 text-right tabular-nums" :class="r.income ? 'text-emerald-600' : 'text-muted-foreground/60'">+{{ fmtQty(r.income) }}</td>
            <td class="px-4 py-2.5 text-right tabular-nums" :class="r.outcome ? 'text-rose-600' : 'text-muted-foreground/60'">−{{ fmtQty(r.outcome) }}</td>
            <td class="px-4 py-2.5 text-right font-semibold tabular-nums" :class="r.closing < 0 ? 'text-rose-600' : ''">{{ fmtQty(r.closing) }} <span class="text-xs font-normal text-muted-foreground">{{ r.unit }}</span></td>
          </tr>
        </tbody>
        <tfoot v-if="visible.length" class="sticky bottom-0 border-t-2 bg-card text-sm font-semibold">
          <tr>
            <td class="px-4 py-3" colspan="4">{{ $t('movement.totalCount', { count: visible.length }) }}</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ moneySum(stats.value) }}</td>
          </tr>
        </tfoot>
      </table>
      </template>
      <p v-if="visible.length" class="px-4 py-3 text-xs text-muted-foreground max-lg:hidden sm:px-6">{{ $t('movement.cursorHint') }}</p>
    </div>
  </div>
</template>
