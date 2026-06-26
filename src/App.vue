<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRouter, useRoute } from 'vue-router'
import { ShoppingBag, Receipt, Clock, UserCircle2, Box, FolderTree, BarChart3, Monitor, Sun, Moon, LogOut, Settings, LayoutGrid } from 'lucide-vue-next'
import { theme, setTheme } from './lib/theme'
import { logout } from './lib/auth'
import { appVersion } from './lib/version'
import { checkForUpdate } from './lib/updater'
import { runDueBackup } from './lib/backup'
import logoDark from './assets/logo-dark.svg'
import ConfirmDialog from './components/ConfirmDialog.vue'
import Toaster from './components/Toaster.vue'
import UpdatePrompt from './components/UpdatePrompt.vue'

const router = useRouter()
const route = useRoute()
function doLogout() { logout(); router.push('/login') }

// Mobil: native uslubdagi pastki tab bar + "Ko'proq" sheet.
const moreOpen = ref(false)
watch(() => route.fullPath, () => { moreOpen.value = false })

// Pastki tab bar — kassir uchun eng muhim 4 bo'lim.
const bottomNav = [
  { to: '/pos', label: 'Kassa', icon: ShoppingBag },
  { to: '/sales', label: 'Sotuvlar', icon: Receipt },
  { to: '/products', label: 'Mahsulot', icon: Box },
  { to: '/customers', label: 'Mijozlar', icon: UserCircle2 },
]
// "Ko'proq" sheet — qolgan bo'limlar.
const moreItems = [
  { to: '/shifts', label: 'Smenalar', icon: Clock },
  { to: '/categories', label: 'Kategoriyalar', icon: FolderTree },
  { to: '/reports', label: 'Hisobotlar', icon: BarChart3 },
  { to: '/settings', label: 'Sozlamalar', icon: Settings },
]
const moreActive = ref(false)
watch(() => route.path, (p) => { moreActive.value = moreItems.some((m) => p.startsWith(m.to)) }, { immediate: true })

onMounted(() => {
  // Internet bo'lsa — yangilanish tekshirish; offline'da jim.
  setTimeout(() => checkForUpdate(), 3000)
  // Kunlik backup (kerak bo'lsa) — lokal + online GitHub sync.
  runDueBackup().catch(() => {})
})

const groups = [
  { label: 'Savdo', items: [
    { to: '/pos', label: 'POS kassa', icon: ShoppingBag },
    { to: '/sales', label: 'Sotuvlar', icon: Receipt },
    { to: '/shifts', label: 'Smenalar', icon: Clock },
    { to: '/customers', label: 'Mijozlar', icon: UserCircle2 },
  ] },
  { label: 'Katalog', items: [
    { to: '/products', label: 'Mahsulotlar', icon: Box },
    { to: '/categories', label: 'Kategoriyalar', icon: FolderTree },
  ] },
  { label: 'Boshqaruv', items: [
    { to: '/reports', label: 'Hisobotlar', icon: BarChart3 },
    { to: '/settings', label: 'Sozlamalar', icon: Settings },
  ] },
]
const themes = [
  { v: 'system', icon: Monitor, label: 'Tizim' },
  { v: 'light', icon: Sun, label: 'Yorug' },
  { v: 'dark', icon: Moon, label: 'Qorong' },
] as const
</script>

<template>
  <!-- Login sahifasi — to'liq ekran, sidebar yo'q -->
  <RouterView v-if="$route.name === 'login'" />

  <div v-else class="flex h-screen overflow-hidden bg-background text-foreground">
    <!-- Desktop sidebar (mobil'da yashirin — mobil pastki tab bar ishlatadi) -->
    <aside class="hidden w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground lg:flex">
      <div class="flex items-center gap-2.5 px-5 py-5">
        <div class="h-9 w-9 shrink-0 overflow-hidden rounded-xl shadow-sm ring-1 ring-black/10">
          <img :src="logoDark" class="h-full w-full" alt="OpenSales" />
        </div>
        <div class="leading-tight">
          <div class="text-sm font-semibold">OpenSales</div>
          <div class="text-xs text-muted-foreground">POS tizimi</div>
        </div>
      </div>
      <nav class="flex-1 space-y-5 overflow-y-auto px-3 py-2">
        <div v-for="g in groups" :key="g.label">
          <div class="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-muted-foreground/70 uppercase">{{ g.label }}</div>
          <div class="space-y-0.5">
            <RouterLink
              v-for="item in g.items"
              :key="item.to"
              :to="item.to"
              class="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              active-class="!bg-primary/10 !text-primary"
            >
              <component :is="item.icon" class="h-[18px] w-[18px] shrink-0" />
              {{ item.label }}
            </RouterLink>
          </div>
        </div>
      </nav>
      <div class="space-y-3 border-t p-3">
        <div class="grid grid-cols-3 gap-1 rounded-lg bg-muted/60 p-1">
          <button v-for="t in themes" :key="t.v" @click="setTheme(t.v)" :title="t.label"
            class="flex h-7 items-center justify-center rounded-md transition-colors"
            :class="theme === t.v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'">
            <component :is="t.icon" class="h-4 w-4" />
          </button>
        </div>
        <button @click="doLogout" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-600">
          <LogOut class="h-[18px] w-[18px]" /> Chiqish
        </button>
        <div class="px-1 text-center text-[11px] text-muted-foreground/70">OpenSales POS · v{{ appVersion }}</div>
      </div>
    </aside>

    <!-- Asosiy maydon. Mobil'da pastki tab bar uchun pastdan joy qoldiramiz. -->
    <main class="min-w-0 flex-1 overflow-auto pb-[calc(env(safe-area-inset-bottom)+4.75rem)] lg:pb-0">
      <RouterView />
    </main>

    <!-- Mobil native pastki tab bar — glass -->
    <nav class="fixed inset-x-0 bottom-0 z-40 border-t border-border/40 bg-card/65 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl lg:hidden">
      <div class="mx-auto flex max-w-md items-stretch px-2 pt-1.5">
        <RouterLink
          v-for="item in bottomNav"
          :key="item.to"
          :to="item.to"
          class="flex flex-1 flex-col items-center gap-1 rounded-2xl py-1.5 text-[11px] font-medium text-muted-foreground transition-colors active:scale-95"
          active-class="!text-primary"
        >
          <component :is="item.icon" class="h-[22px] w-[22px]" />
          {{ item.label }}
        </RouterLink>
        <button
          type="button"
          class="flex flex-1 flex-col items-center gap-1 rounded-2xl py-1.5 text-[11px] font-medium transition-colors active:scale-95"
          :class="moreActive ? 'text-primary' : 'text-muted-foreground'"
          @click="moreOpen = true"
        >
          <LayoutGrid class="h-[22px] w-[22px]" />
          Ko'proq
        </button>
      </div>
    </nav>

    <!-- "Ko'proq" sheet — glass bottom sheet -->
    <Transition name="sheet">
      <div v-if="moreOpen" class="fixed inset-0 z-50 lg:hidden">
        <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" @click="moreOpen = false" />
        <div class="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-border/40 bg-card/80 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-2xl backdrop-blur-2xl">
          <div class="mx-auto mb-4 h-1.5 w-10 rounded-full bg-muted-foreground/30" />
          <div class="grid grid-cols-4 gap-2">
            <RouterLink
              v-for="item in moreItems"
              :key="item.to"
              :to="item.to"
              class="flex flex-col items-center gap-1.5 rounded-2xl bg-muted/40 py-3.5 text-xs font-medium text-foreground transition active:scale-95"
              active-class="!bg-primary/10 !text-primary"
            >
              <component :is="item.icon" class="h-6 w-6" />
              {{ item.label }}
            </RouterLink>
          </div>
          <div class="mt-4 flex items-center gap-2">
            <div class="grid flex-1 grid-cols-3 gap-1 rounded-2xl bg-muted/50 p-1">
              <button v-for="t in themes" :key="t.v" @click="setTheme(t.v)" :title="t.label"
                class="flex h-10 items-center justify-center rounded-xl transition-colors"
                :class="theme === t.v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'">
                <component :is="t.icon" class="h-4 w-4" />
              </button>
            </div>
            <button @click="doLogout" class="flex h-12 items-center gap-2 rounded-2xl bg-rose-500/10 px-5 text-sm font-medium text-rose-600 active:scale-95">
              <LogOut class="h-[18px] w-[18px]" /> Chiqish
            </button>
          </div>
          <div class="mt-3 text-center text-[11px] text-muted-foreground/70">OpenSales POS · v{{ appVersion }}</div>
        </div>
      </div>
    </Transition>
  </div>

  <ConfirmDialog />
  <Toaster />
  <UpdatePrompt />
</template>

<style scoped>
/* "Ko'proq" sheet — pastdan ko'tariladi (native his) */
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
