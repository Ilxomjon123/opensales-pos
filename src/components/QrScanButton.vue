<script setup lang="ts">
// Qayta ishlatiladigan skanerlash tugmasi (QR + shtrix kod). Har qanday input yoniga qo'yiladi.
// Ichida QrScanner modal — dekod bo'lgan matnni `decoded` orqali qaytaradi.
import { ref } from 'vue'
import { ScanLine } from 'lucide-vue-next'
import QrScanner from './QrScanner.vue'

const emit = defineEmits<{ decoded: [text: string, format: string] }>()
const open = ref(false)
function onDecoded(t: string, fmt: string) { open.value = false; emit('decoded', t.trim(), fmt) }
</script>

<template>
  <button type="button" @click="open = true" :title="$t('qrScanner.scanCode')"
    class="flex w-10 shrink-0 items-center justify-center self-stretch rounded-md border bg-background text-muted-foreground transition hover:bg-muted hover:text-foreground">
    <ScanLine class="h-4 w-4" />
  </button>
  <QrScanner v-if="open" @decoded="onDecoded" @close="open = false" />
</template>
