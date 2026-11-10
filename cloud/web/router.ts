import { createRouter, createWebHistory } from 'vue-router'
import { routeAllowed } from './lib/auth'

// Sahifalar desktop pos-tauri'niki (src/pages) — bitta kod. Tarix rejimi: Telegram
// initData'ni manzilning #hash qismiga yozadi, hash-router bilan to'qnashardi.
const LAST_ROUTE = 'kassa:last_route'
export function lastRoute(): string {
  try {
    const r = withoutOneShot(localStorage.getItem(LAST_ROUTE) ?? '')
    return r && r !== '/' && routeAllowed(r) ? r : '/pos'
  } catch { return '/pos' }
}

// Bir martalik parametrlar (bot kartasidagi `?draft=`) oxirgi sahifa bilan saqlanmaydi: aks holda keyingi
// "Ilovada ochish" yangi qoralama o'rniga eski id'ni olardi (redirect saqlangan query'ni ustun qo'yardi).
const ONE_SHOT = ['draft']
function withoutOneShot(path: string): string {
  if (!path.includes('?')) return path
  const u = new URL(path, 'http://x')
  for (const k of ONE_SHOT) u.searchParams.delete(k)
  return u.pathname + u.search
}

/** Pastki paneldagi ildiz bo'limlar — ularda Telegram "orqaga" tugmasi ko'rinmaydi. */
export const ROOT_TABS = ['/pos', '/sales', '/products', '/customers']

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    // Kirish manzilining query'si (masalan, `?draft=`) saqlangan sahifa query'sidan ustun.
    {
      path: '/',
      redirect: (to) => {
        const u = new URL(lastRoute(), 'http://x')
        return { path: u.pathname, query: { ...Object.fromEntries(u.searchParams), ...to.query }, hash: to.hash }
      },
    },
    { path: '/pos', name: 'pos', component: () => import('../../src/pages/Pos.vue') },
    { path: '/sales', name: 'sales', component: () => import('../../src/pages/Sales.vue') },
    { path: '/returns', name: 'returns', component: () => import('../../src/pages/Returns.vue') },
    { path: '/shifts', name: 'shifts', component: () => import('../../src/pages/Shifts.vue') },
    { path: '/customers', name: 'customers', component: () => import('../../src/pages/Customers.vue') },
    { path: '/customers/:id', name: 'customer', component: () => import('../../src/pages/CustomerShow.vue') },
    { path: '/products', name: 'products', component: () => import('../../src/pages/Products.vue') },
    { path: '/categories', name: 'categories', component: () => import('../../src/pages/Categories.vue') },
    { path: '/receipts', name: 'receipts', component: () => import('../../src/pages/Receipts.vue') },
    { path: '/movement', name: 'movement', component: () => import('../../src/pages/Movement.vue') },
    { path: '/movement/:id(\\d+)', name: 'product-movement', component: () => import('../../src/pages/ProductMovement.vue') },
    { path: '/expenses', name: 'expenses', component: () => import('../../src/pages/Expenses.vue') },
    { path: '/reports', name: 'reports', component: () => import('../../src/pages/Reports.vue') },
    { path: '/settings', name: 'settings', component: () => import('./pages/CloudSettings.vue') },
    { path: '/staff', name: 'staff', component: () => import('./pages/Staff.vue') },
    { path: '/admin', name: 'admin', component: () => import('./pages/Admin.vue') },
    { path: '/transfers', name: 'transfers', component: () => import('./pages/Transfers.vue') },
    { path: '/business', name: 'business', component: () => import('./pages/Business.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/pos' },
  ],
})

router.beforeEach((to) => {
  if (!routeAllowed(to.path)) return '/pos'
})

router.afterEach((to) => {
  try { localStorage.setItem(LAST_ROUTE, withoutOneShot(to.fullPath)) } catch { /* */ }
})
