<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Send, Eye, BellRing, BellOff, Loader2, MessageCircleOff } from 'lucide-vue-next'
import { api, RpcError } from '../rpc'
import { viewShop } from '../session'
import { haptic, openTelegramLink } from '../telegram'
import { notify } from '../../../src/lib/notify'

// Admin → Varonka: reklamadan kelganlar qayerda to'xtayapti (bot/ilova → do'kon → tovar → sotuv → 2-kun),
// qaysi manba ishlayapti, kimga yozish kerak. Avtomatik eslatmalar shu yerda yoqiladi (standart o'chiq).
type Stage = 'entered' | 'shop' | 'product' | 'sale' | 'day2'
type Row = {
  uid: number; name: string | null; username: string | null; src: string | null
  started_at: string | null; opened_at: string | null; shop_id: string | null; shop_at: string | null
  products: number; sales: number; product_at: string | null; sale_at: string | null; day2_at: string | null; last_sale_at: string | null
  pm_at: string | null; created_at: string; shop_name: string | null; nudges: { kind: string; status: string; at: string }[]
}
type Report = {
  days: number
  stages: Record<'entered' | 'started' | 'opened' | 'shop' | 'product' | 'sale' | 'day2' | 'pm', number>
  sources: { src: string; n: number; shop: number; sale: number }[]
  rows: Row[]
  nudges: { enabled: boolean; support: boolean }
}

const { t } = useI18n()
const days = ref(30)
const report = ref<Report | null>(null)
const loading = ref(true)
const toggling = ref(false)

function fail(e: unknown) { notify(e instanceof RpcError ? t(e.code, e.params) : String(e), 'error') }
async function load() {
  loading.value = true
  try { report.value = await api<Report>('/api/admin/funnel', { days: days.value }) } catch (e) { fail(e) } finally { loading.value = false }
}
onMounted(load)
watch(days, () => { haptic('select'); void load() })

const STAGES: Stage[] = ['entered', 'shop', 'product', 'sale', 'day2']
const bars = computed(() => {
  const s = report.value?.stages
  if (!s) return []
  const top = Math.max(s.entered, 1)
  return STAGES.map((k, i) => {
    const n = s[k]
    const prev = i === 0 ? n : s[STAGES[i - 1]]
    return { k, n, pct: Math.round((n / top) * 100), step: i === 0 || !prev ? null : Math.round((n / prev) * 100) }
  })
})

function stageOf(r: Row): Stage {
  return r.day2_at ? 'day2' : r.sale_at ? 'sale' : r.product_at ? 'product' : r.shop_at ? 'shop' : 'entered'
}
const STAGE_TONE: Record<Stage, string> = {
  entered: 'bg-muted text-muted-foreground',
  shop: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  product: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  sale: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  day2: 'bg-emerald-600 text-white',
}

/** "2 soat oldin" — oxirgi harakat (sotuv yoki bosqich). */
function ago(iso: string | null): string {
  if (!iso) return ''
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  if (m < 60) return t('cloud.funnel.agoMin', { n: m })
  if (m < 48 * 60) return t('cloud.funnel.agoHour', { n: Math.round(m / 60) })
  return t('cloud.funnel.agoDay', { n: Math.round(m / 1440) })
}
const lastAt = (r: Row) => r.last_sale_at ?? r.product_at ?? r.shop_at ?? r.opened_at ?? r.started_at ?? r.created_at

function write(r: Row) {
  if (!r.username) return
  haptic('select')
  openTelegramLink(`https://t.me/${r.username}`)
}
const entering = ref<string | null>(null)
async function look(r: Row) {
  if (!r.shop_id || entering.value) return
  entering.value = r.shop_id
  haptic('select')
  try { await viewShop(r.shop_id) } catch (e) { entering.value = null; notify(t((e as Error).message || 'cloud.errors.internal'), 'error') }
}
async function setNudges(on: boolean) {
  if (!report.value || toggling.value || report.value.nudges.enabled === on) return
  toggling.value = true
  try {
    report.value = await api<Report>('/api/admin/nudges', { enabled: on, days: days.value })
    haptic('success')
  } catch (e) { fail(e) } finally { toggling.value = false }
}
</script>

<template>
  <div class="space-y-3">
    <div class="fn-chips">
      <button v-for="d in [7, 30, 0]" :key="d" type="button" :class="{ on: days === d }" @click="days = d">{{ d ? $t('cloud.funnel.days', { n: d }) : $t('cloud.funnel.all') }}</button>
    </div>

    <div v-if="loading && !report" class="space-y-2">
      <div v-for="i in 5" :key="i" class="h-11 animate-pulse rounded-xl bg-muted/60" />
    </div>
    <template v-else-if="report">
      <!-- Bosqichlar: uzunlik — kirganlarga nisbatan, o'ngda — oldingi bosqichdan o'tganlar foizi -->
      <section class="space-y-1.5 rounded-2xl border bg-card p-3" :class="{ 'opacity-60': loading }">
        <div v-for="b in bars" :key="b.k" class="fn-bar">
          <span class="fn-fill" :style="{ width: `${Math.max(b.pct, b.n ? 4 : 0)}%` }" />
          <span class="relative min-w-0 flex-1 truncate">{{ $t(`cloud.funnel.stage.${b.k}`) }}</span>
          <b class="relative tabular-nums">{{ b.n }}</b>
          <span class="relative w-12 text-right text-[11px] tabular-nums text-muted-foreground">{{ b.step === null ? '' : `${b.step}%` }}</span>
        </div>
        <p class="pt-1 text-[11px] text-muted-foreground">{{ $t('cloud.funnel.entryNote', { started: report.stages.started, opened: report.stages.opened, pm: report.stages.pm }) }}</p>
      </section>

      <section v-if="report.sources.length" class="rounded-2xl border bg-card p-3">
        <div class="mb-2 text-xs font-semibold text-muted-foreground">{{ $t('cloud.funnel.sources') }}</div>
        <div v-for="s in report.sources" :key="s.src" class="flex items-center gap-2 py-1 text-sm">
          <span class="min-w-0 flex-1 truncate font-medium">{{ s.src || $t('cloud.funnel.noSrc') }}</span>
          <span class="text-xs tabular-nums text-muted-foreground">{{ $t('cloud.funnel.srcLine', { n: s.n, shop: s.shop, sale: s.sale }) }}</span>
        </div>
      </section>

      <!-- Avtomatik eslatmalar -->
      <section class="rounded-2xl border bg-card p-3">
        <div class="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <component :is="report.nudges.enabled ? BellRing : BellOff" class="h-4 w-4" /> {{ $t('cloud.funnel.nudges') }}
        </div>
        <div class="fn-seg" role="radiogroup">
          <button type="button" role="radio" :aria-checked="report.nudges.enabled" :class="{ on: report.nudges.enabled }" :disabled="toggling" @click="setNudges(true)">{{ $t('cloud.funnel.nudgesOn') }}</button>
          <button type="button" role="radio" :aria-checked="!report.nudges.enabled" :class="{ on: !report.nudges.enabled }" :disabled="toggling" @click="setNudges(false)">{{ $t('cloud.funnel.nudgesOff') }}</button>
        </div>
        <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">{{ $t('cloud.funnel.nudgesHint') }}{{ report.nudges.support ? '' : ' ' + $t('cloud.funnel.noSupport') }}</p>
      </section>

      <h2 class="px-1 pt-1 text-sm font-semibold text-muted-foreground">{{ $t('cloud.funnel.people', { n: report.rows.length }) }}</h2>
      <section class="divide-y rounded-2xl border bg-card">
        <div v-for="r in report.rows" :key="r.uid" class="p-3">
          <div class="flex items-center gap-2">
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-semibold">{{ r.shop_name || r.name || r.uid }}</div>
              <div class="truncate text-xs text-muted-foreground">
                {{ r.username ? '@' + r.username : r.name }}<template v-if="r.src"> · {{ r.src }}</template> · {{ ago(lastAt(r)) }}
              </div>
              <div v-if="!r.pm_at" class="mt-0.5 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
                <MessageCircleOff class="h-3 w-3 shrink-0" /><span class="truncate">{{ $t('cloud.funnel.noPm') }}</span>
              </div>
            </div>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold" :class="STAGE_TONE[stageOf(r)]">{{ $t(`cloud.funnel.stage.${stageOf(r)}`) }}</span>
          </div>
          <div class="mt-2 flex items-center gap-2">
            <span v-if="r.shop_id" class="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground">{{ $t('cloud.funnel.counts', { products: r.products, sales: r.sales }) }}</span>
            <span v-else class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ $t('cloud.funnel.noShopYet') }}</span>
            <span v-for="n in r.nudges" :key="n.kind" class="shrink-0 text-[10px] text-muted-foreground" :title="n.at">{{ n.status === 'sent' ? '🔔' : '⚠️' }}{{ $t(`cloud.funnel.kind.${n.kind}`) }}</span>
            <button v-if="r.username" type="button" class="fn-act" @click="write(r)"><Send class="h-3.5 w-3.5" />{{ $t('cloud.funnel.write') }}</button>
            <button v-if="r.shop_id" type="button" class="fn-act" :disabled="!!entering" @click="look(r)">
              <Loader2 v-if="entering === r.shop_id" class="h-3.5 w-3.5 animate-spin" /><Eye v-else class="h-3.5 w-3.5" />{{ $t('cloud.funnel.look') }}
            </button>
          </div>
        </div>
        <div v-if="!report.rows.length" class="p-6 text-center text-sm text-muted-foreground">{{ $t('cloud.funnel.empty') }}</div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.fn-chips {
  display: flex;
  gap: 0.5rem;
}
.fn-chips button {
  height: 2.25rem;
  padding: 0 0.875rem;
  border-radius: 9999px;
  font-size: 0.8125rem;
  font-weight: 500;
}
.fn-chips button.on {
  background: var(--primary);
  color: var(--primary-foreground);
}
.fn-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2.25rem;
  padding: 0 0.625rem;
  overflow: hidden;
  border-radius: 0.625rem;
  background: var(--muted);
  font-size: 0.8125rem;
}
.fn-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: color-mix(in srgb, var(--primary) 22%, transparent);
  transition: width 0.3s ease;
}
.fn-seg {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 9999px;
  background: var(--secondary);
}
.fn-seg button {
  height: 2.25rem;
  border-radius: 9999px;
  color: var(--muted-foreground);
  font-size: 0.875rem;
  font-weight: 600;
}
.fn-seg button.on {
  background: var(--primary);
  color: var(--primary-foreground);
}
.fn-act {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 0.25rem;
  height: 1.875rem;
  padding: 0 0.625rem;
  border: 1px solid var(--border);
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
}
.fn-act:disabled {
  opacity: 0.4;
}
</style>
