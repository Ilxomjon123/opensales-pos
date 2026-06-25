<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { X, RefreshCw, Copy, Download, FolderOpen, Check } from 'lucide-vue-next'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { appLogDir, downloadDir, join } from '@tauri-apps/api/path'
import { openPath } from '@tauri-apps/plugin-opener'
import { notify } from '../lib/notify'

const LOG_FILE = 'OpenSales POS.log'
defineEmits<{ close: [] }>()

const text = ref('')
const loading = ref(false)
const copied = ref(false)
const box = ref<HTMLElement>()

async function logPath() { return await join(await appLogDir(), LOG_FILE) }

async function load() {
  loading.value = true
  try {
    text.value = await readTextFile(await logPath())
  } catch (e: any) {
    text.value = ''
    notify('Log o\'qilmadi: ' + (e?.message ?? e), 'error')
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
    const dest = await join(await downloadDir(), `opensales-log-${stamp}.txt`)
    await writeTextFile(dest, text.value)
    notify('Yuklandi: Downloads papkasiga', 'success')
    await openPath(await downloadDir())
  } catch (e: any) { notify('Yuklab bo\'lmadi: ' + (e?.message ?? e), 'error') }
}
async function openFolder() {
  try { await openPath(await appLogDir()) } catch (e: any) { notify(e?.message ?? 'Xato', 'error') }
}
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
    <div class="flex h-[80vh] w-full max-w-3xl flex-col rounded-xl border bg-card shadow-xl">
      <div class="flex items-center justify-between border-b px-5 py-3">
        <div class="text-base font-semibold">Tizim loglari</div>
        <div class="flex items-center gap-1.5">
          <button @click="load" :disabled="loading" title="Yangilash" class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm hover:bg-muted"><RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" /></button>
          <button @click="copy" title="Nusxalash" class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm hover:bg-muted"><component :is="copied ? Check : Copy" class="h-4 w-4" /> Nusxa</button>
          <button @click="download" title="Yuklab olish" class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm hover:bg-muted"><Download class="h-4 w-4" /> Yuklab olish</button>
          <button @click="openFolder" title="Papkani ochish" class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm hover:bg-muted"><FolderOpen class="h-4 w-4" /></button>
          <button @click="$emit('close')" class="ml-1 rounded-md p-1.5 hover:bg-muted"><X class="h-5 w-5" /></button>
        </div>
      </div>
      <div ref="box" class="flex-1 overflow-auto bg-muted/30 p-4">
        <pre v-if="text" class="font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground">{{ text }}</pre>
        <div v-else-if="!loading" class="flex h-full items-center justify-center text-sm text-muted-foreground">Log bo'sh</div>
      </div>
    </div>
  </div>
</template>
