<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, Search, X } from 'lucide-vue-next'
import { translitMatch } from '../../../src/lib/format'
import GlassSheet from './GlassSheet.vue'

// Desktop src/components/SearchableSelect.vue ning bulut versiyasi (vite.config.ts → SWAP):
// props/emit bir xil, ko'rinishi — shisha maydon + pastdan varaq, tepada qidiruv (hostel kabi).
defineOptions({ inheritAttrs: false })
const { t } = useI18n()

type Item = { value: number | string; label: string }
const props = withDefaults(defineProps<{
  modelValue: number | string | null | undefined
  items: Item[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  clearable?: boolean
}>(), {
  clearable: false,
})
const emit = defineEmits<{ 'update:modelValue': [v: number | string | null] }>()

const placeholderText = computed(() => props.placeholder ?? t('searchableSelect.placeholder'))
const selected = computed(() => props.items.find((i) => String(i.value) === String(props.modelValue)) ?? null)

const open = ref(false)
const search = ref('')
const filtered = computed(() => {
  const q = search.value.trim()
  return q ? props.items.filter((i) => translitMatch(i.label, q)) : props.items
})
// Telefonda klaviatura darhol chiqmasin — qidiruv bir bosishda; sichqonchali qurilmada fokus.
const autofocus = typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches

function show() { search.value = ''; open.value = true }
function pick(i: Item) { open.value = false; emit('update:modelValue', i.value) }
function clear() { open.value = false; emit('update:modelValue', null) }
</script>

<template>
  <button type="button" v-bind="$attrs" class="glass-field w-full" aria-haspopup="listbox" :aria-expanded="open" @click="show">
    <span class="glass-field-value" :class="{ unset: !selected }">{{ selected?.label ?? placeholderText }}</span>
    <X v-if="clearable && selected" class="glass-field-icon !opacity-80" role="button" :aria-label="t('cloud.field.clear')" @click.stop="clear" />
    <ChevronDown v-else class="glass-field-icon" />
  </button>
  <GlassSheet :open="open" :title="placeholderText" tall @close="open = false">
    <div class="glass-sheet-search">
      <Search class="h-[18px] w-[18px]" />
      <input v-model="search" type="search" enterkeyhint="done" :autofocus="autofocus"
        :placeholder="searchPlaceholder ?? t('cloud.field.search')" @keyup.enter="filtered.length === 1 && pick(filtered[0]!)" />
    </div>
    <div class="glass-options" role="listbox">
      <button v-if="clearable && selected" type="button" class="glass-option muted" @click="clear">
        <span class="min-w-0 flex-1 truncate">{{ placeholderText }}</span>
      </button>
      <button v-for="i in filtered" :key="i.value" type="button" role="option" class="glass-option"
        :class="{ on: selected?.value === i.value }" :aria-selected="selected?.value === i.value" @click="pick(i)">
        <span class="min-w-0 flex-1 truncate">{{ i.label }}</span>
        <Check v-if="selected?.value === i.value" class="h-[18px] w-[18px] shrink-0" />
      </button>
      <div v-if="filtered.length === 0" class="glass-options-empty">{{ emptyText ?? t('cloud.field.empty') }}</div>
    </div>
  </GlassSheet>
</template>
