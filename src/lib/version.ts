import { ref } from 'vue'
import { getVersion } from '@tauri-apps/api/app'

// Dastur versiyasi (tauri.conf.json'dan). Sidebar va login'da ko'rsatiladi.
export const appVersion = ref('')
getVersion().then((v) => (appVersion.value = v)).catch(() => {})
