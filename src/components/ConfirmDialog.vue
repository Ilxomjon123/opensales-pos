<script setup lang="ts">
import { confirmState, answer } from '../lib/confirm'
import { AlertTriangle } from 'lucide-vue-next'
</script>

<template>
  <div v-if="confirmState.open" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
    <div class="w-full max-w-sm rounded-xl border bg-card p-5 shadow-xl">
      <div class="flex items-start gap-3">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full" :class="confirmState.danger ? 'bg-rose-500/15 text-rose-600' : 'bg-primary/10 text-primary'">
          <AlertTriangle class="h-5 w-5" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-base font-semibold">{{ confirmState.title }}</div>
          <p class="mt-1 text-sm text-muted-foreground">{{ confirmState.message }}</p>
        </div>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button @click="answer(false)" class="h-9 rounded-md border px-4 text-sm hover:bg-muted">{{ $t('common.cancel') }}</button>
        <button @click="answer(true)" class="h-9 rounded-md px-4 text-sm font-medium text-white" :class="confirmState.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-primary hover:bg-primary/90'">{{ $t('common.yes') }}</button>
      </div>
    </div>
  </div>
</template>
