<script setup lang="ts">
import { Download, X, RefreshCw } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { updateInfo, updating, updateProgress, installUpdate, dismissUpdate } from '../lib/updater'
import { notify } from '../lib/notify'

const { t } = useI18n()

async function run() {
  try { await installUpdate() }
  catch (e: any) { notify(t('updatePrompt.updateError', { error: e?.message ?? e }), 'error') }
}
</script>

<template>
  <div v-if="updateInfo" class="fixed right-5 bottom-5 z-[70] w-80 rounded-xl border bg-card p-4 shadow-2xl">
    <div class="flex items-start gap-3">
      <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Download class="h-4.5 w-4.5" /></div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between">
          <div class="text-sm font-semibold">{{ $t('updatePrompt.newVersion', { version: updateInfo.version }) }}</div>
          <button v-if="!updating" @click="dismissUpdate" class="rounded p-1 text-muted-foreground hover:bg-muted"><X class="h-4 w-4" /></button>
        </div>
        <p v-if="updateInfo.notes" class="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{{ updateInfo.notes }}</p>

        <div v-if="updating" class="mt-3">
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div class="h-full rounded-full bg-primary transition-all" :style="{ width: updateProgress + '%' }"></div>
          </div>
          <div class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><RefreshCw class="h-3 w-3 animate-spin" /> {{ $t('updatePrompt.downloading', { percent: updateProgress }) }}</div>
        </div>

        <div v-else class="mt-3 flex gap-2">
          <button @click="run" class="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90"><Download class="h-3.5 w-3.5" /> {{ $t('updatePrompt.update') }}</button>
          <button @click="dismissUpdate" class="h-8 rounded-lg border px-3 text-xs hover:bg-muted">{{ $t('updatePrompt.later') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
