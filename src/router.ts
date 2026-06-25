import { createRouter, createWebHashHistory } from 'vue-router'
import { isAuthed } from './lib/auth'
import { license } from './lib/license'

const routes = [
  { path: '/', redirect: '/pos' },
  { path: '/activate', name: 'activate', component: () => import('./pages/Activation.vue') },
  { path: '/login', name: 'login', component: () => import('./pages/Login.vue') },
  { path: '/pos', name: 'pos', component: () => import('./pages/Pos.vue') },
  { path: '/sales', name: 'sales', component: () => import('./pages/Sales.vue') },
  { path: '/shifts', name: 'shifts', component: () => import('./pages/Shifts.vue') },
  { path: '/customers', name: 'customers', component: () => import('./pages/Customers.vue') },
  { path: '/customers/:id', name: 'customer', component: () => import('./pages/CustomerShow.vue') },
  { path: '/products', name: 'products', component: () => import('./pages/Products.vue') },
  { path: '/categories', name: 'categories', component: () => import('./pages/Categories.vue') },
  { path: '/reports', name: 'reports', component: () => import('./pages/Reports.vue') },
  { path: '/settings', name: 'settings', component: () => import('./pages/Settings.vue') },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

router.beforeEach((to) => {
  if (!license.value.active && to.name !== 'activate') return { name: 'activate' }
  if (license.value.active && to.name === 'activate') return { name: 'pos' }
  if (to.name !== 'login' && to.name !== 'activate' && !isAuthed.value) return { name: 'login' }
  if (to.name === 'login' && isAuthed.value) return { name: 'pos' }
})
