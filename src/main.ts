import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { setCurrency } from './lib/format'
import { getSetting } from './lib/db'
import { initTheme } from './lib/theme'
import { refreshLicense } from './lib/license'

initTheme()

const app = createApp(App)
app.use(router)

// Litsenziyani mount'dan oldin yuklash (guard to'g'ri ishlashi uchun)
refreshLicense().catch(() => {}).finally(() => app.mount('#app'))

// Valyuta belgisini sozlamadan o'qish
getSetting('currency_symbol', "so'm").then(setCurrency).catch(() => {})
