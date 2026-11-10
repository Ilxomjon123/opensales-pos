<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Store, Languages, BadgeCheck, Users, ChevronRight, UserCircle2, ShieldCheck } from 'lucide-vue-next'
import { session, isOwner } from '../session'
import { setSetting } from '../lib/db'
import { availableLocales, setLocale, i18n, type Locale } from '../lib/i18n'
import { notify } from '../../../src/lib/notify'
import { setCurrency } from '../../../src/lib/format'

// Bulut sozlamalari: desktop Settings.vue'dagi printer/zaxira/litsenziya/PIN bu yerda
// yo'q (Telegram'da ma'nosi yo'q). Do'kon sozlamalarini faqat egasi o'zgartiradi; til —
// har qurilmada o'zi.
const { t } = useI18n()
const owner = computed(() => isOwner())

const shopName = ref(session.settings.shop_name ?? session.shop?.name ?? '')
const currency = ref(session.settings.currency_symbol ?? "so'm")
const flag = (k: string) => session.settings[k] === '1'

async function save(key: string, value: string) {
  try {
    await setSetting(key, value)
    if (key === 'currency_symbol') setCurrency(value)
    notify(t('cloud.settings.saved'), 'success')
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), 'error')
  }
}
function toggle(key: string) { void save(key, flag(key) ? '0' : '1') }

const locale = computed(() => i18n.global.locale.value as Locale)
const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—')
</script>

<template>
  <div class="min-h-full">
    <header class="page-header">
      <h1 class="text-lg font-semibold">{{ $t('cloud.settings.title') }}</h1>
    </header>

    <div class="mx-auto max-w-xl space-y-4 p-4">
      <!-- Hisob -->
      <section class="rounded-2xl border bg-card p-4">
        <div class="flex items-center gap-3">
          <UserCircle2 class="h-9 w-9 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <div class="truncate font-semibold">{{ session.user?.name }}</div>
            <div class="text-xs text-muted-foreground">{{ $t(`cloud.settings.role.${session.user?.role ?? 'cashier'}`) }} · {{ session.shop?.name }}</div>
          </div>
        </div>
      </section>

      <!-- Do'kon (egasi) -->
      <section v-if="owner" class="space-y-3 rounded-2xl border bg-card p-4">
        <div class="flex items-center gap-2 text-sm font-semibold"><Store class="h-4 w-4" /> {{ $t('cloud.settings.shop') }}</div>
        <label class="block text-xs text-muted-foreground">{{ $t('cloud.shopName') }}</label>
        <div class="flex gap-2">
          <input v-model="shopName" maxlength="80" class="h-10 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm" />
          <button @click="save('shop_name', shopName.trim())" :disabled="shopName.trim().length < 2"
            class="h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">OK</button>
        </div>
        <label class="block text-xs text-muted-foreground">{{ $t('cloud.settings.currency') }}</label>
        <div class="flex gap-2">
          <input v-model="currency" maxlength="10" class="h-10 w-28 rounded-lg border bg-background px-3 text-sm" />
          <button @click="save('currency_symbol', currency.trim())" :disabled="!currency.trim()"
            class="h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">OK</button>
        </div>
        <button v-for="k in ['allow_negative_stock', 'keep_cart', 'cashier_discount']" :key="k" @click="toggle(k)"
          class="flex w-full items-center gap-3 rounded-xl bg-muted/40 px-3 py-3 text-left">
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">{{ $t(`cloud.settings.${k === 'allow_negative_stock' ? 'allowNegative' : k === 'keep_cart' ? 'keepCart' : 'cashierDiscount'}`) }}</span>
            <span v-if="k !== 'cashier_discount'" class="block text-xs text-muted-foreground">{{ $t(`cloud.settings.${k === 'allow_negative_stock' ? 'allowNegativeHint' : 'keepCartHint'}`) }}</span>
          </span>
          <span class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="flag(k) ? 'bg-primary' : 'bg-muted-foreground/30'">
            <span class="absolute top-0.5 h-5 w-5 rounded-full bg-background shadow transition-all" :class="flag(k) ? 'left-[22px]' : 'left-0.5'" />
          </span>
        </button>
      </section>

      <!-- Xodimlar -->
      <RouterLink v-if="owner" to="/staff" class="flex items-center gap-3 rounded-2xl border bg-card p-4">
        <Users class="h-5 w-5" />
        <span class="flex-1 text-sm font-semibold">{{ $t('cloud.settings.staff') }}</span>
        <ChevronRight class="h-4 w-4 text-muted-foreground" />
      </RouterLink>

      <!-- Platforma admini: barcha do'konlar, obuna, bloklash (faqat ADMIN_CHAT_ID) -->
      <RouterLink v-if="session.admin" to="/admin" class="flex items-center gap-3 rounded-2xl border bg-card p-4">
        <ShieldCheck class="h-5 w-5 text-primary" />
        <span class="flex-1">
          <span class="block text-sm font-semibold">{{ $t('cloud.admin.title') }}</span>
          <span class="block text-xs text-muted-foreground">{{ $t('cloud.admin.subtitle') }}</span>
        </span>
        <ChevronRight class="h-4 w-4 text-muted-foreground" />
      </RouterLink>

      <!-- Til -->
      <section class="rounded-2xl border bg-card p-4">
        <div class="mb-3 flex items-center gap-2 text-sm font-semibold"><Languages class="h-4 w-4" /> {{ $t('cloud.settings.language') }}</div>
        <div class="grid grid-cols-2 gap-2">
          <button v-for="l in availableLocales" :key="l.code" @click="setLocale(l.code)"
            class="h-10 rounded-lg border text-sm font-medium" :class="locale === l.code ? 'border-primary bg-primary text-primary-foreground' : ''">
            {{ l.label }}
          </button>
        </div>
      </section>

      <!-- Obuna -->
      <section v-if="owner && session.subscription" class="rounded-2xl border bg-card p-4">
        <div class="mb-2 flex items-center gap-2 text-sm font-semibold"><BadgeCheck class="h-4 w-4" /> {{ $t('cloud.settings.subscription') }}</div>
        <div class="text-sm">{{ $t('cloud.settings.trialUntil', { date: fmt(session.subscription.trialUntil) }) }}</div>
        <div v-if="session.subscription.paidUntil" class="text-sm">{{ $t('cloud.settings.paidUntil', { date: fmt(session.subscription.paidUntil) }) }}</div>
      </section>
    </div>
  </div>
</template>
