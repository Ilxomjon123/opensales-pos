import { ref } from 'vue'
import { t } from './i18n'

type State = {
  open: boolean
  title: string
  message: string
  danger: boolean
  confirmText: string | null
  cancelText: string | null
  resolve: ((v: boolean) => void) | null
}

export const confirmState = ref<State>({ open: false, title: '', message: '', danger: false, confirmText: null, cancelText: null, resolve: null })

// confirmText/cancelText — amal nomi "Bekor qilish" bo'lgan joyda tugmalar chalkashmasin.
export function confirmDialog(message: string, opts?: { title?: string; danger?: boolean; confirmText?: string; cancelText?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = {
      open: true,
      title: opts?.title ?? t('common.confirmTitle'),
      message,
      danger: opts?.danger ?? false,
      confirmText: opts?.confirmText ?? null,
      cancelText: opts?.cancelText ?? null,
      resolve,
    }
  })
}

export function answer(v: boolean) {
  confirmState.value.resolve?.(v)
  confirmState.value = { ...confirmState.value, open: false, resolve: null }
}
