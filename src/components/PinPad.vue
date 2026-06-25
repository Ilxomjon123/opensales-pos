<script setup lang="ts">
import { ref, watch } from 'vue'
import { Delete } from 'lucide-vue-next'

const props = defineProps<{ error?: boolean }>()
const emit = defineEmits<{ complete: [pin: string]; update: [pin: string] }>()

const pin = ref('')
const shake = ref(false)
const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

function press(k: string) { if (pin.value.length < 4) { pin.value += k } }
function back() { pin.value = pin.value.slice(0, -1) }
function reset() { pin.value = '' }
defineExpose({ reset, shakeNow: () => { shake.value = true; setTimeout(() => { shake.value = false; pin.value = '' }, 500) } })

watch(pin, (v) => {
  emit('update', v)
  if (v.length === 4) emit('complete', v)
})
</script>

<template>
  <div>
    <div class="mb-6 flex justify-center gap-3" :class="shake ? 'animate-[shake_0.4s]' : ''">
      <span v-for="i in 4" :key="i" class="h-3.5 w-3.5 rounded-full border-2 transition-colors"
        :class="props.error ? 'border-rose-500 bg-rose-500' : pin.length >= i ? 'border-primary bg-primary' : 'border-muted-foreground/40'"></span>
    </div>
    <div class="grid grid-cols-3 gap-3">
      <button v-for="k in keys" :key="k" @click="press(k)" class="flex h-16 items-center justify-center rounded-2xl border bg-card text-2xl font-semibold transition-all hover:bg-muted active:scale-95">{{ k }}</button>
      <div></div>
      <button @click="press('0')" class="flex h-16 items-center justify-center rounded-2xl border bg-card text-2xl font-semibold transition-all hover:bg-muted active:scale-95">0</button>
      <button @click="back" class="flex h-16 items-center justify-center rounded-2xl text-muted-foreground transition-all hover:bg-muted active:scale-95"><Delete class="h-6 w-6" /></button>
    </div>
  </div>
</template>

<style>
@keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-8px)} 75%{transform:translateX(8px)} }
</style>
