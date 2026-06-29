<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { X, RefreshCw, Copy, Download, FolderOpen, Check, Trash2 } from 'lucide-vue-next'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { appLogDir, downloadDir, join } from '@tauri-apps/api/path'
import { openPath } from '@tauri-apps/plugin-opener'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const FILES = { all: 'OpenSales POS.log', errors: 'errors.log' } as const
defineEmits<{ close: [] }>()

const tab = ref<'all' | 'errors'>('all')
const text = ref('')
const loading = ref(false)
const copied = ref(false)
const box = ref<HTMLElement>()

async function logPath() { return await join(await appLogDir(), FILES[tab.value]) }
function setTab(t: 'all' | 'errors') { tab.value = t; load() }

async function load() {
  loading.value = true
  try {
    text.value = await readTextFile(await logPath())
  } catch {
    text.value = '' // fayl hali yo'q bo'lishi mumkin (xato bo'lmagan)
  } finally {
    loading.value = false
    await nextTick()
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  }
}
onMounted(load)

async function copy() {
  try { await navigator.clipboard.writeText(text.value); copied.value = true; setTimeout(() => (copied.value = false), 1500) } catch {}
}
async function download() {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const dest = await join(await downloadDir(), `opensales-${tab.value}-${stamp}.txt`)
    await writeTextFile(dest, text.value)
    notify(t('logViewer.downloaded'), 'success')
    await openPath(await downloadDir())
  } catch (e: any) { notify(t('logViewer.downloadFailed', { error: e?.message ?? e }), 'error') }
}
async function openFolder() {
  try { await openPath(await appLogDir()) } catch (e: any) { notify(e?.message ?? t('logViewer.error'), 'error') }
}
async function clear() {
  const name = tab.value === 'errors' ? t('logViewer.errors') : t('logViewer.all')
  if (!(await confirmDialog(t('logViewer.clearConfirm', { name }), { danger: true, title: t('logViewer.clearTitle') }))) return
  try { await writeTextFile(await logPath(), ''); text.value = ''; notify(t('logViewer.cleared'), 'success') }
  catch (e: any) { notify(t('logViewer.clearFailed', { error: e?.message ?? e }), 'error') }
}
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
    <div class="flex h-[80vh] w-full max-w-3xl flex-col rounded-xl border bg-card shadow-xl">
      <div class="flex items-center justify-between border-b px-5 py-3">
        <div class="flex items-center gap-3">
          <div class="text-base font-semibold">{{ $t('logViewer.title') }}</div>
          <div class="flex rounded-lg border p-0.5 text-sm">
            <button @click="setTab('all')" class="rounded-md px-2.5 py-1" :class="tab === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'">{{ $t('logViewer.all') }}</button>
            <button @click="setTab('errors')" class="rounded-md px-2.5 py-1" :class="tab === 'errors' ? 'bg-rose-600 text-white' : 'text-muted-foreground hover:text-foreground'">{{ $t('logViewer.errors') }}</button>
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <button @click="load" :disabled="loading" :title="$t('logViewer.refresh')" class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm hover:bg-muted"><RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" /></button>
          <button @click="copy" :title="$t('logViewer.copy')" class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm hover:bg-muted"><component :is="copied ? Check : Copy" class="h-4 w-4" /> {{ $t('logViewer.copyShort') }}</button>
          <button @click="download" :title="$t('logViewer.download')" class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm hover:bg-muted"><Download class="h-4 w-4" /> {{ $t('logViewer.download') }}</button>
          <button @click="openFolder" :title="$t('logViewer.openFolder')" class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm hover:bg-muted"><FolderOpen class="h-4 w-4" /></button>
          <button @click="clear" :title="$t('logViewer.clear')" class="flex h-8 items-center gap-1.5 rounded-md border border-rose-500/40 px-2.5 text-sm text-rose-600 hover:bg-rose-500/10"><Trash2 class="h-4 w-4" /> {{ $t('logViewer.clear') }}</button>
          <button @click="$emit('close')" class="ml-1 rounded-md p-1.5 hover:bg-muted"><X class="h-5 w-5" /></button>
        </div>
      </div>
      <div ref="box" class="flex-1 overflow-auto bg-muted/30 p-4">
        <pre v-if="text" class="font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground">{{ text }}</pre>
        <div v-else-if="!loading" class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ tab === 'errors' ? $t('logViewer.noErrors') : $t('logViewer.emptyLog') }}</div>
      </div>
    </div>
  </div>
</template>
