import { ref } from 'vue'

type State = {
  open: boolean
  title: string
  message: string
  danger: boolean
  resolve: ((v: boolean) => void) | null
}

export const confirmState = ref<State>({ open: false, title: '', message: '', danger: false, resolve: null })

export function confirmDialog(message: string, opts?: { title?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = {
      open: true,
      title: opts?.title ?? 'Tasdiqlang',
      message,
      danger: opts?.danger ?? false,
      resolve,
    }
  })
}

export function answer(v: boolean) {
  confirmState.value.resolve?.(v)
  confirmState.value = { ...confirmState.value, open: false, resolve: null }
}
