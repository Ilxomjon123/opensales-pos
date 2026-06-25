<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { ShoppingBag, Receipt, Clock, UserCircle2, Box, FolderTree, BarChart3, Monitor, Sun, Moon, LogOut, Settings } from 'lucide-vue-next'
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
function doLogout() { logout(); router.push('/login') }

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
    <aside class="flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
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

    <main class="min-w-0 flex-1 overflow-hidden">
      <RouterView />
    </main>
  </div>

  <ConfirmDialog />
  <Toaster />
  <UpdatePrompt />
</template>
