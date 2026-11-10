<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Plus, Store, GitBranch, Copy, Loader2 } from 'lucide-vue-next'
import GlassSheet from './GlassSheet.vue'
import GlassSelect from './GlassSelect.vue'
import { session, ownedShops, switchShop, createShop, isOwner, type ShopListItem } from '../session'
import { haptic } from '../telegram'
import { notify } from '../../../src/lib/notify'

// Do'konlar (2026-11-09): ro'yxat va almashtirish; ega — yangi do'kon: ALOHIDA (o'z katalogi, xohlasa
// boshqa do'kon katalogidan nusxa) yoki FILIAL (katalog — tovar, narx, rasm — asosiy do'kondan sinxron;
// qoldiq, sotuv, kassa, xodimlar filialniki). Obuna biznesning birinchi do'koniga bog'langan.
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const mode = ref<'list' | 'new'>('list')
const busy = ref<string | null>(null)
const name = ref('')
const kind = ref<'separate' | 'branch'>('separate')
const copyFrom = ref<string | null>(null)
const master = ref<string | null>(null)

watch(() => props.open, (o) => { if (o) { mode.value = 'list'; busy.value = null } })

/** Katalog manbai bo'la oladigan do'konlar — o'zi filial bo'lmaganlar. */
const sources = computed(() => ownedShops().filter((x) => !x.catalogOf))
const canCreate = computed(() => isOwner())

function sub(x: ShopListItem): string {
  if (x.role !== 'owner') return t('cloud.settings.role.cashier')
  if (x.catalogOf) return t('cloud.shops.branchOf', { name: x.catalogOfName ?? '—' })
  return x.root ? t('cloud.shops.main') : t('cloud.shops.separate')
}

function errText(e: unknown): string {
  const err = e as Error & { params?: Record<string, unknown> }
  return t(err.message || 'cloud.errors.internal', err.params ?? {})
}

async function pick(x: ShopListItem) {
  if (x.id === session.shop?.id || busy.value) { emit('close'); return }
  busy.value = x.id
  haptic('select')
  try { await switchShop(x.id) } catch (e) { busy.value = null; notify(errText(e), 'error') }
}

function startNew() {
  name.value = ''
  kind.value = 'separate'
  copyFrom.value = null
  const cur = session.shop
  master.value = cur && !cur.catalogOf ? cur.id : sources.value[0]?.id ?? null
  mode.value = 'new'
  haptic('select')
}

const nameOk = computed(() => name.value.trim().length >= 2 && name.value.trim().length <= 80)
async function create() {
  if (!nameOk.value || busy.value) return
  if (kind.value === 'branch' && !master.value) return
  busy.value = 'new'
  try {
    await createShop({ name: name.value.trim(), catalogOf: kind.value === 'branch' ? master.value : null, copyFrom: kind.value === 'separate' ? copyFrom.value : null })
    haptic('success')
  } catch (e) { busy.value = null; notify(errText(e), 'error') }
}
</script>

<template>
  <GlassSheet :open="open" :title="mode === 'list' ? $t('cloud.shops.title') : $t('cloud.shops.new')" :sub="mode === 'list' ? $t('cloud.shops.subtitle') : ''" @close="emit('close')">
    <div v-if="mode === 'list'" class="shop-body">
      <button v-for="x in session.shops" :key="x.id" type="button" class="shop-row" :class="{ on: x.id === session.shop?.id }" :disabled="!!busy" @click="pick(x)">
        <span class="shop-ico"><component :is="x.catalogOf ? GitBranch : Store" class="h-5 w-5" /></span>
        <span class="min-w-0 flex-1 text-left">
          <span class="block truncate font-semibold">{{ x.name }}</span>
          <span class="block truncate text-xs text-muted-foreground">{{ sub(x) }}</span>
        </span>
        <Loader2 v-if="busy === x.id" class="h-5 w-5 animate-spin text-muted-foreground" />
        <Check v-else-if="x.id === session.shop?.id" class="h-5 w-5 text-primary" />
      </button>
      <button v-if="canCreate" type="button" class="shop-add" @click="startNew">
        <Plus class="h-5 w-5" /> {{ $t('cloud.shops.add') }}
      </button>
      <p v-if="canCreate" class="px-1 text-center text-[11px] leading-relaxed text-muted-foreground">{{ $t('cloud.shops.subscriptionNote') }}</p>
    </div>

    <div v-else class="shop-body">
      <label class="block">
        <span class="mb-1 block text-xs font-medium text-muted-foreground">{{ $t('cloud.shops.name') }}</span>
        <input v-model="name" maxlength="80" :placeholder="$t('cloud.shops.namePlaceholder')" class="h-11 w-full rounded-xl border bg-background px-3 text-sm" />
      </label>
      <div class="shop-seg" role="radiogroup">
        <span class="shop-seg-lens" :style="{ transform: kind === 'branch' ? 'translateX(100%)' : 'none' }" aria-hidden="true" />
        <button type="button" role="radio" :aria-checked="kind === 'separate'" :class="{ on: kind === 'separate' }" @click="kind = 'separate'; haptic('select')"><Store class="h-4 w-4" /> {{ $t('cloud.shops.kindSeparate') }}</button>
        <button type="button" role="radio" :aria-checked="kind === 'branch'" :class="{ on: kind === 'branch' }" :disabled="!sources.length" @click="kind = 'branch'; haptic('select')"><GitBranch class="h-4 w-4" /> {{ $t('cloud.shops.kindBranch') }}</button>
      </div>
      <p class="text-xs leading-relaxed text-muted-foreground">{{ kind === 'branch' ? $t('cloud.shops.hintBranch') : $t('cloud.shops.hintSeparate') }}</p>

      <label v-if="kind === 'separate'" class="block">
        <span class="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Copy class="h-3.5 w-3.5" /> {{ $t('cloud.shops.copyCatalog') }}</span>
        <GlassSelect v-model="copyFrom" class="h-11 w-full rounded-xl border bg-background px-3 text-sm">
          <option :value="null">{{ $t('cloud.shops.copyNone') }}</option>
          <option v-for="x in sources" :key="x.id" :value="x.id">{{ x.name }}</option>
        </GlassSelect>
      </label>
      <label v-else class="block">
        <span class="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><GitBranch class="h-3.5 w-3.5" /> {{ $t('cloud.shops.catalogSource') }}</span>
        <GlassSelect v-model="master" class="h-11 w-full rounded-xl border bg-background px-3 text-sm">
          <option v-for="x in sources" :key="x.id" :value="x.id">{{ x.name }}</option>
        </GlassSelect>
      </label>

      <div class="grid grid-cols-[auto_1fr] gap-2 pt-1">
        <button type="button" class="h-11 rounded-xl border px-4 text-sm font-medium" :disabled="busy === 'new'" @click="mode = 'list'">{{ $t('common.back') }}</button>
        <button type="button" class="flex h-11 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50" :disabled="!nameOk || busy === 'new'" @click="create">
          <Loader2 v-if="busy === 'new'" class="h-4 w-4 animate-spin" />
          {{ kind === 'branch' ? $t('cloud.shops.createBranch') : $t('cloud.shops.create') }}
        </button>
      </div>
    </div>
  </GlassSheet>
</template>

<style scoped>
.shop-body {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  overflow-y: auto;
  padding: 0.25rem 1rem 0.5rem;
}
.shop-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 1rem;
  background: var(--card);
  transition: transform 0.15s ease, border-color 0.2s ease;
}
.shop-row:active {
  transform: scale(0.98);
}
.shop-row.on {
  border-color: var(--primary);
}
.shop-ico {
  display: grid;
  place-items: center;
  width: 2.5rem;
  height: 2.5rem;
  flex: none;
  border-radius: 0.75rem;
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
}
.shop-add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  height: 2.75rem;
  border: 1.5px dashed var(--border);
  border-radius: 1rem;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--primary);
}
.shop-seg {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 3px;
  border-radius: 0.875rem;
  background: var(--muted);
}
.shop-seg-lens {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc(50% - 3px);
  border-radius: 0.7rem;
  background: var(--card);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.12);
  transition: transform 0.25s cubic-bezier(0.32, 0.72, 0, 1);
}
.shop-seg button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  height: 2.5rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--muted-foreground);
}
.shop-seg button.on {
  color: var(--foreground);
}
.shop-seg button:disabled {
  opacity: 0.4;
}
</style>
