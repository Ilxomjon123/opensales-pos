import { ref } from 'vue'

export type Toast = { id: number; message: string; type: 'success' | 'error' | 'info' }
export const toasts = ref<Toast[]>([])
let seq = 1

export function notify(message: string, type: Toast['type'] = 'info') {
  const id = seq++
  toasts.value.push({ id, message, type })
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, 3200)
}
