<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Search, Check, X } from 'lucide-vue-next'
import { translitMatch } from '../lib/format'

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
const searchPlaceholderText = computed(() => props.searchPlaceholder ?? t('searchableSelect.searchPlaceholder'))
const emptyTextText = computed(() => props.emptyText ?? t('searchableSelect.emptyText'))

const open = ref(false)
const search = ref('')
const root = ref<HTMLElement | null>(null)

const selected = computed(() => props.items.find((i) => String(i.value) === String(props.modelValue)) ?? null)
const filtered = computed(() => {
  const q = search.value.trim()
  return q ? props.items.filter((i) => translitMatch(i.label, q)) : props.items
})

function pick(i: Item) { emit('update:modelValue', i.value); open.value = false; search.value = '' }
function clear(e: Event) { e.stopPropagation(); emit('update:modelValue', null) }
function toggle() { open.value = !open.value; if (open.value) search.value = '' }
function onOutside(e: MouseEvent) { if (root.value && !root.value.contains(e.target as Node)) open.value = false }
onMounted(() => document.addEventListener('click', onOutside))
onBeforeUnmount(() => document.removeEventListener('click', onOutside))
</script>

<template>
  <div ref="root" class="relative">
    <button type="button" @click="toggle"
      class="flex h-10 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none">
      <span class="truncate" :class="selected ? '' : 'text-muted-foreground'">{{ selected?.label ?? placeholderText }}</span>
      <span class="flex shrink-0 items-center gap-1">
        <X v-if="clearable && selected" class="h-4 w-4 text-muted-foreground hover:text-foreground" @click="clear" />
        <ChevronDown class="h-4 w-4 text-muted-foreground transition-transform" :class="open ? 'rotate-180' : ''" />
      </span>
    </button>

    <div v-if="open" class="absolute z-50 mt-1 flex max-h-72 w-full min-w-56 flex-col overflow-hidden rounded-md border bg-popover shadow-lg">
      <div class="border-b p-2">
        <div class="relative">
          <Search class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input v-model="search" :placeholder="searchPlaceholderText" autofocus
            class="h-8 w-full rounded border bg-background pr-2 pl-7 text-sm focus:ring-1 focus:ring-primary/30 focus:outline-none" @click.stop />
        </div>
      </div>
      <div class="flex-1 overflow-y-auto p-1">
        <button v-for="i in filtered" :key="i.value" type="button" @click="pick(i)"
          class="flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-sm hover:bg-muted"
          :class="String(i.value) === String(modelValue) ? 'bg-muted' : ''">
          <span class="truncate">{{ i.label }}</span>
          <Check v-if="String(i.value) === String(modelValue)" class="h-3.5 w-3.5 shrink-0 text-primary" />
        </button>
        <div v-if="filtered.length === 0" class="py-6 text-center text-xs text-muted-foreground">{{ emptyTextText }}</div>
      </div>
    </div>
  </div>
</template>
