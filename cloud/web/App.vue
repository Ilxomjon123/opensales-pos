<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import {
  ShoppingBag, Receipt, Clock, UserCircle2, Box, FolderTree, BarChart3, Settings, LayoutGrid, Wallet, RotateCcw,
  PackagePlus, ArrowLeftRight, Users, AlertTriangle, ChevronLeft, Sparkles,
  ShieldCheck, Truck, Building2, Store, GitBranch, ChevronRight, Eye, LogOut, Loader2,
} from 'lucide-vue-next'
import ConfirmDialog from '../../src/components/ConfirmDialog.vue'
import Toaster from '../../src/components/Toaster.vue'
import Gate from './pages/Gate.vue'
import { session, isOwner, ownedShops, exitView } from './session'
import { notify } from '../../src/lib/notify'
import ShopSheet from './components/ShopSheet.vue'
import { routeAllowed } from './lib/auth'
import { ROOT_TABS } from './router'
import { setBackButton, openTelegramLink, haptic } from './telegram'
import { navDir } from './nav'
import Assistant from './components/Assistant.vue'
import { assistant, openAssistant } from './assistant'
import { dataVersion } from './freshness'

// Telegram kassa qobig'i: suzuvchi shisha pastki panel + "Ko'proq" varag'i (style.css →
// liquid glass). Haqiqiy blur faqat shu suzuvchi qatlamlarda, kartalarda emas.
const route = useRoute()

// ---- Sahifa keshi (KeepAlive) ------------------------------------------------------------------
// Qayta kirish darhol (yuklanishsiz). Yangidan yuklanadi faqat: (1) kirilgandan beri biror yozuv bo'lgan
// bo'lsa (sotuv, to'lov... — eskirgan ma'lumot ko'rsatilmasin), (2) boshqa sahifadan so'rov bilan
// ochilsa (masalan, /sales?q=1-00002), (3) AI yordamchi shu sahifada saqlasa.
const pageKeys = reactive<Record<string, string>>({})
const seenVersion: Record<string, number> = {}
let keyNonce = 0
function freshKey(path: string) {
  pageKeys[path] = `${path}#${++keyNonce}`
  seenVersion[path] = dataVersion.value
}
watch(() => route.path, (path) => {
  const linkedWithQuery = navDir.value === 'push' && Object.keys(route.query).length > 0
  if (seenVersion[path] === undefined || seenVersion[path] !== dataVersion.value || linkedWithQuery) freshKey(path)
}, { immediate: true, flush: 'pre' })
// AI yordamchi yozdi — ko'rinib turgan sahifa ham yangilansin (avvalgi xatti-harakat).
watch(() => assistant.version, () => freshKey(route.path))
// Sahifa almashganda kirish animatsiyasi (o'ram endi qayta yaratilmaydi — klass qayta qo'yiladi).
const pageEl = ref<HTMLElement | null>(null)
watch(() => route.path, () => {
  void nextTick(() => {
    const el = pageEl.value
    if (!el) return
    el.classList.remove('page-anim')
    void el.offsetWidth
    el.classList.add('page-anim')
  })
})
const router = useRouter()
const { t } = useI18n()

const moreOpen = ref(false)
const shopsOpen = ref(false)
watch(() => route.fullPath, () => { moreOpen.value = false; shopsOpen.value = false })
/** Biznesda ikki va undan ko'p o'z do'koni — ko'chirish va umumiy hisobot ko'rinadi. */
const multiShop = computed(() => isOwner() && ownedShops().length >= 2)
function openShops() { moreOpen.value = false; shopsOpen.value = true; haptic('select') }

const bottomNav = computed(() => [
  { to: '/pos', label: t('app.navPos'), icon: ShoppingBag },
  { to: '/sales', label: t('app.navSales'), icon: Receipt },
  { to: '/products', label: t('app.navProduct'), icon: Box },
  { to: '/customers', label: t('app.navCustomers'), icon: UserCircle2 },
].filter((i) => routeAllowed(i.to)))

const moreItems = computed(() => [
  { to: '/returns', label: t('app.navReturns'), icon: RotateCcw },
  { to: '/receipts', label: t('app.navReceipts'), icon: PackagePlus },
  { to: '/shifts', label: t('app.navShifts'), icon: Clock },
  { to: '/categories', label: t('app.navCategories'), icon: FolderTree },
  { to: '/expenses', label: t('app.navExpenses'), icon: Wallet },
  { to: '/reports', label: t('app.navReports'), icon: BarChart3 },
  ...(multiShop.value ? [{ to: '/business', label: t('cloud.business.nav'), icon: Building2 }, { to: '/transfers', label: t('cloud.transfers.nav'), icon: Truck }] : []),
  { to: '/movement', label: t('app.navMovement'), icon: ArrowLeftRight },
  { to: '/staff', label: t('app.navStaff'), icon: Users },
  { to: '/settings', label: t('app.navSettings'), icon: Settings },
  { to: '/admin', label: t('cloud.admin.title'), icon: ShieldCheck },
].filter((i) => routeAllowed(i.to) && (i.to !== '/staff' || isOwner())))
const moreActive = computed(() => moreItems.value.some((m) => route.path.startsWith(m.to)))
// Faol tab indeksi — shisha linza shu joyga siljiydi (-1: hech biri, linza yashirin).
const activeTab = computed(() => {
  const i = bottomNav.value.findIndex((n) => route.path === n.to || route.path.startsWith(`${n.to}/`))
  if (i >= 0) return i
  return moreActive.value || moreOpen.value ? bottomNav.value.length : -1
})

// Orqaga: ilova ichidagi tarix bo'yicha; tarix yo'q bo'lsa (havoladan ochilgan) — ota bo'lim.
function goBack() {
  if (window.history.state?.back) router.back()
  else router.replace(route.path.split('/').slice(0, -1).join('/') || '/pos')
}
// Bot kartasidagi "Ilovada ochish" (?draft=<id>) — kirish tugagach yordamchi o'sha qoralama bilan ochiladi.
// Router query'sidan o'qiladi (location emas): boshlang'ich redirect (`/` → oxirgi sahifa) hali tugamagan bo'lishi mumkin.
watch(() => [session.status, route.query.draft] as const, ([st, id]) => {
  if (st !== 'ok' || id === undefined) return
  const { draft: _drop, ...rest } = route.query
  router.replace({ query: rest })
  if (typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)) openAssistant(id)
}, { immediate: true })

// Ichki sahifa (/customers/2, /movement/7) — chap yuqorida suzuvchi shisha "orqaga" tugmasi.
const showBack = computed(() => route.path.split('/').filter(Boolean).length >= 2)
watch(() => [route.path, session.status, assistant.open] as const, ([p, st, ai]) => {
  // Yordamchi ochiq — Telegram "orqaga" tugmasi uning ichida yuradi (chat → ro'yxat → yopish).
  if (ai && assistant.back) { setBackButton(true, () => assistant.back?.()); return }
  setBackButton(st === 'ok' && !ROOT_TABS.includes(p), goBack)
}, { immediate: true })

const daysLeft = computed(() => {
  const s = session.subscription
  if (!s) return null
  const until = [s.trialUntil, s.paidUntil].filter(Boolean).sort().pop()!
  return Math.ceil((Date.parse(until) - Date.now()) / 86400_000)
})
const banner = computed<{ kind: 'warn' | 'error'; text: string } | null>(() => {
  const s = session.subscription
  if (!s || session.view) return null
  if (s.status === 'blocked') return { kind: 'error', text: t('cloud.blocked') }
  if (!session.subscriptionActive || (daysLeft.value !== null && daysLeft.value <= 0)) return { kind: 'error', text: t('cloud.expired') }
  const onTrial = !s.paidUntil || s.paidUntil < s.trialUntil
  if (onTrial && daysLeft.value !== null && daysLeft.value <= 5) return { kind: 'warn', text: t('cloud.trialLeft', { days: daysLeft.value }) }
  return null
})
// Admin ko'rish rejimi: tepada doimiy banner, «Chiqish» — o'z do'koniga (Admin sahifasiga) qaytadi.
const leaving = ref(false)
async function leaveView() {
  if (leaving.value) return
  leaving.value = true
  haptic('select')
  try { await exitView() } catch (e) { leaving.value = false; notify(t((e as Error).message || 'cloud.errors.internal'), 'error') }
}
const supportTg = import.meta.env.VITE_SUPPORT_TG ?? ''
function contact() {
  if (supportTg) openTelegramLink(`https://t.me/${supportTg.replace(/^@/, '')}`)
  else router.push('/settings')
}
</script>

<template>
  <Gate v-if="session.status !== 'ok'" />

  <div v-else class="app-shell flex h-[var(--app-h)] flex-col overflow-hidden text-foreground" :class="{ 'has-back': showBack }">
    <div v-if="session.view" class="view-banner flex shrink-0 items-center gap-2 px-4 py-2 text-xs font-medium">
      <Eye class="h-4 w-4 shrink-0" />
      <span class="min-w-0 flex-1 truncate">{{ $t('cloud.admin.viewBanner', { shop: session.shop?.name ?? '', owner: session.view.owner }) }}</span>
      <button type="button" class="flex shrink-0 items-center gap-1 rounded-md border border-current/30 px-2 py-1" :disabled="leaving" @click="leaveView">
        <Loader2 v-if="leaving" class="h-3.5 w-3.5 animate-spin" /><LogOut v-else class="h-3.5 w-3.5" /> {{ $t('cloud.admin.exitView') }}
      </button>
    </div>
    <div v-if="banner" class="flex shrink-0 items-center gap-2 px-4 py-2 text-xs font-medium"
      :class="banner.kind === 'error' ? 'bg-rose-600 text-white' : 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200'">
      <AlertTriangle class="h-4 w-4 shrink-0" />
      <span class="min-w-0 flex-1">{{ banner.text }}</span>
      <button v-if="isOwner()" @click="contact" class="shrink-0 rounded-md border border-current/30 px-2 py-1">{{ $t('cloud.contact') }}</button>
    </div>

    <main class="min-h-0 flex-1 overflow-auto">
      <!-- Sticky, balandligi 0: tugma main tepasida (banner ostida) turadi, scroll'da ham, joy egallamaydi. -->
      <div class="tg-back-wrap">
        <Transition name="tg-back">
          <button v-if="showBack" type="button" class="tg-back" :aria-label="$t('common.back')" @click="haptic('select'); goBack()"><ChevronLeft class="h-6 w-6" /></button>
        </Transition>
      </div>
      <!-- Rol aniqlangach ruxsatsiz sahifa bir lahza ham ochilmasin (yo'naltirish asinxron). -->
      <!-- Kalit — marshrut yozuvi (parametr emas): sahifa almashganda yangisi animatsiya bilan
           paydo bo'ladi (style.css → .page-anim, yo'nalish nav.ts'dan). -->
      <RouterView v-if="routeAllowed(route.path)" v-slot="{ Component, route: r }">
        <div ref="pageEl" class="page-anim h-full" :data-nav="navDir">
          <!-- Sahifalar xotirada (qayta kirish — darhol, holat va scroll bilan); kalit pageKeys'da (freshness.ts). -->
          <KeepAlive :max="12">
            <component :is="Component" :key="pageKeys[r.path] ?? r.path" />
          </KeepAlive>
        </div>
      </RouterView>
    </main>

    <!-- AI yordamchisi: gapiring yoki yozing → tasdiqlang. Kassada savat tugmasidan yuqorida. -->
    <button v-if="!showBack && session.ai" type="button" class="ai-fab" :class="{ high: route.path === '/pos' }" :aria-label="$t('cloud.ai.title')" @click="haptic('select'); openAssistant()">
      <Sparkles class="h-6 w-6" />
    </button>
    <Assistant />

    <div class="tg-tabbar">
      <nav :style="{ '--tabs': bottomNav.length + 1, '--i': activeTab }">
        <span v-show="activeTab >= 0" class="tg-lens" aria-hidden="true" />
        <RouterLink v-for="(item, idx) in bottomNav" :key="item.to" :to="item.to" class="tg-tab" :class="{ on: activeTab === idx }" @click="haptic('select')">
          <component :is="item.icon" class="h-[22px] w-[22px]" />
          <span>{{ item.label }}</span>
        </RouterLink>
        <button type="button" @click="moreOpen = true; haptic('select')" class="tg-tab" :class="{ on: activeTab === bottomNav.length }">
          <LayoutGrid class="h-[22px] w-[22px]" />
          <span>{{ $t('app.more') }}</span>
        </button>
      </nav>
    </div>

    <Transition name="sheet">
      <div v-if="moreOpen" class="fixed inset-0 z-50">
        <div class="absolute inset-0 bg-black/40" @click="moreOpen = false" />
        <div class="tg-sheet absolute inset-x-0 bottom-0 p-4 pb-[calc(var(--safe-bottom)+1rem)]">
          <div class="mx-auto mb-4 h-1.5 w-10 rounded-full bg-muted-foreground/30" />
          <!-- Joriy do'kon: bir nechta do'kon bo'lsa almashtirish, ega — yangi do'kon ochish. -->
          <button v-if="!session.view && (session.shops.length > 1 || isOwner())" type="button" class="tg-sheet-item mb-2 flex w-full items-center gap-3 px-3 py-3 text-left active:scale-[0.98]" @click="openShops">
            <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><component :is="session.shop?.catalogOf ? GitBranch : Store" class="h-5 w-5" /></span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-semibold">{{ session.shop?.name }}</span>
              <span class="block truncate text-xs text-muted-foreground">{{ session.shops.length > 1 ? $t('cloud.shops.count', { n: session.shops.length }) : $t('cloud.shops.addHint') }}</span>
            </span>
            <ChevronRight class="h-5 w-5 shrink-0 text-muted-foreground" />
          </button>
          <div class="grid grid-cols-4 gap-2">
            <RouterLink v-for="item in moreItems" :key="item.to" :to="item.to"
              class="tg-sheet-item flex flex-col items-center gap-1.5 px-1 py-3.5 text-center text-xs font-medium text-foreground transition active:scale-95"
              active-class="!bg-primary !text-primary-foreground">
              <component :is="item.icon" class="h-6 w-6" />
              {{ item.label }}
            </RouterLink>
          </div>
          <div class="mt-3 text-center text-[11px] text-muted-foreground/70">
            {{ session.shop?.name }} · {{ session.user?.name }} · {{ session.view ? $t('cloud.admin.viewMode') : $t(`cloud.settings.role.${session.user?.role ?? 'cashier'}`) }}
          </div>
        </div>
      </div>
    </Transition>
  </div>

  <ShopSheet :open="shopsOpen" @close="shopsOpen = false" />
  <ConfirmDialog />
  <Toaster />
</template>

<style scoped>
/* Ko'rish rejimi banneri: Telegram mavzusidan teskari (oq-qora), ogohlantirish rangi emas — bu xato emas, rejim. */
.view-banner {
  background: var(--foreground);
  color: var(--background);
}
.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.2s ease;
}
.sheet-enter-active > div:last-child,
.sheet-leave-active > div:last-child {
  transition: transform 0.25s cubic-bezier(0.32, 0.72, 0, 1);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from > div:last-child,
.sheet-leave-to > div:last-child {
  transform: translateY(100%);
}
</style>
