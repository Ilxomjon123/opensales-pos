<script setup lang="ts">
import { toasts } from '../lib/notify'
import { CheckCircle2, XCircle, Info } from 'lucide-vue-next'
</script>

<template>
  <div class="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id"
        class="pointer-events-auto flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium shadow-lg"
        :class="t.type === 'error' ? 'border-rose-500/30 bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300' : t.type === 'success' ? 'border-emerald-500/30 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-foreground text-background'">
        <component :is="t.type === 'error' ? XCircle : t.type === 'success' ? CheckCircle2 : Info" class="h-4 w-4 shrink-0" />
        {{ t.message }}
      </div>
    </TransitionGroup>
  </div>
</template>

<style>
.toast-enter-active, .toast-leave-active { transition: all 0.25s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(10px); }
</style>
