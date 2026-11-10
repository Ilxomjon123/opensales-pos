<script setup lang="ts">
import { computed, onMounted, onUpdated, ref, shallowRef, useAttrs } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'
import GlassSheet from './GlassSheet.vue'

// Native <select> o'rniga (bulut build'i sahifalardagi `<select>` ni shunga almashtiradi —
// vite.config.ts → cloudFields). Sahifa kodi o'zgarmaydi: `v-model` va `<option>` lar xuddi
// native'dagidek; variantlar yashirin slotdan o'qiladi. Ko'rinishi: shisha maydon → pastdan
// varaq (hostel mini app'idagi kabi). Klass/atributlar maydon tugmasiga o'tadi.
defineOptions({ inheritAttrs: false })
const props = defineProps<{ modelValue?: unknown; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: unknown]; change: [v: unknown] }>()
const attrs = useAttrs()

type Opt = { value: unknown; label: string; disabled: boolean }
const bag = ref<HTMLElement | null>(null)
const opts = shallowRef<Opt[]>([])
let sig = ''
function read() {
  const list = [...(bag.value?.querySelectorAll('option') ?? [])].map((o) => ({
    // Vue `:value` bilan bog'langan qiymatni (raqam, null) `_value` da saqlaydi.
    value: '_value' in o ? (o as HTMLOptionElement & { _value: unknown })._value : o.value,
    label: (o.textContent ?? '').trim(),
    disabled: o.disabled,
  }))
  const next = JSON.stringify(list.map((o) => [String(o.value), o.label, o.disabled]))
  if (next !== sig) { sig = next; opts.value = list }
}
onMounted(read)
onUpdated(read)

const same = (a: unknown, b: unknown) => a === b || String(a ?? '') === String(b ?? '')
const chosen = computed(() => opts.value.find((o) => same(o.value, props.modelValue)) ?? null)
const title = computed(() => (attrs['aria-label'] as string | undefined) ?? (attrs.title as string | undefined) ?? opts.value[0]?.label ?? '')

const open = ref(false)
function pick(o: Opt) {
  open.value = false
  if (same(o.value, props.modelValue)) return
  emit('update:modelValue', o.value)
  emit('change', o.value)
}
</script>

<template>
  <button type="button" v-bind="attrs" class="glass-field" :disabled="disabled || opts.length === 0"
    aria-haspopup="listbox" :aria-expanded="open" @click="open = true">
    <span class="glass-field-value" :class="{ unset: !chosen }">{{ chosen?.label ?? '—' }}</span>
    <ChevronDown class="glass-field-icon" />
  </button>
  <div ref="bag" hidden><slot /></div>
  <GlassSheet :open="open" :title="title" :tall="opts.length > 8" @close="open = false">
    <div class="glass-options" role="listbox">
      <button v-for="(o, i) in opts" :key="i" type="button" role="option" class="glass-option"
        :class="{ on: same(o.value, modelValue) }" :aria-selected="same(o.value, modelValue)" :disabled="o.disabled" @click="pick(o)">
        <span class="min-w-0 flex-1 truncate">{{ o.label }}</span>
        <Check v-if="same(o.value, modelValue)" class="h-[18px] w-[18px] shrink-0" />
      </button>
    </div>
  </GlassSheet>
</template>
