<script setup lang="ts">
import { computed, ref, useAttrs, watch } from 'vue'
import { currencySymbol } from '../../../src/lib/format'

// Pul maydoni (hostel mini app'idagi MoneyInput kabi): yozilishi bilan 3 tadan guruhlanadi
// (15000000 → 15 000 000), o'ngda do'kon valyutasi (so'm / $ / ₽), dollar uchun 2 xona kasr.
// Uzun summada shrift kichrayadi — boshidagi raqamlar yashirinib qolmaydi. Kursor joyida qoladi.
// Bulut build'i sahifalardagi pul `<input type="number" v-model.number>` larini shunga almashtiradi
// (vite.config.ts → cloudTemplates). Qiymat: son, bo'sh bo'lsa '' (v-model.number bilan bir xil).
defineOptions({ inheritAttrs: false })
const props = defineProps<{ modelValue?: number | string | null; currency?: string }>()
const emit = defineEmits<{ 'update:modelValue': [v: number | ''] }>()
const attrs = useAttrs()

// Kenglik/joylashuv klasslari o'ramga, ko'rinish klasslari input'ga.
const WRAP = /^(?:[a-z0-9]+:)*(?:w-|min-w-|max-w-|flex-|grow|shrink|basis-|col-span|self-|order-|m[lrxtby]?-)/
const classes = computed(() => String(attrs.class ?? '').split(/\s+/).filter(Boolean))
const wrapClass = computed(() => classes.value.filter((c) => WRAP.test(c)).join(' '))
const inputClass = computed(() => classes.value.filter((c) => !WRAP.test(c)).join(' '))
const inputAttrs = computed(() => {
  const { class: _c, style: _s, ...rest } = attrs
  return rest
})

function groupStr(clean: string): string {
  const [int, dec] = clean.split('.')
  const g = (int || (dec !== undefined ? '0' : '')).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return dec !== undefined ? `${g}.${dec}` : g
}
function format(v: unknown): string {
  if (v === '' || v === null || v === undefined) return ''
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  const s = String(Math.round(n * 100) / 100)
  return groupStr(s)
}
const toNum = (s: string) => {
  const c = s.replace(/[^\d.]/g, '')
  return c === '' || c === '.' ? '' : Number(c)
}

const display = ref(format(props.modelValue))
watch(() => props.modelValue, (v) => {
  if (toNum(display.value) !== (v === '' || v === null || v === undefined ? '' : Number(v))) display.value = format(v)
})

function onInput(e: Event) {
  const input = e.target as HTMLInputElement
  const raw = input.value
  const caret = input.selectionStart ?? raw.length
  const before = raw.slice(0, caret).replace(/,/g, '.').replace(/[^\d.]/g, '').length
  let clean = raw.replace(/,/g, '.').replace(/[^\d.]/g, '')
  const dot = clean.indexOf('.')
  if (dot >= 0) clean = clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, '').slice(0, 2)
  clean = clean.replace(/^0+(?=\d)/, '').slice(0, 16)
  const formatted = groupStr(clean)
  display.value = formatted
  input.value = formatted
  let pos = 0
  let seen = 0
  while (pos < formatted.length && seen < before) { if (/[\d.]/.test(formatted[pos])) seen++; pos++ }
  input.setSelectionRange(pos, pos)
  emit('update:modelValue', toNum(clean))
}

/** Suffiks: berilgan valyuta (masalan, narx dollarda aytilgan) yoki do'kon valyutasi. */
const suffix = computed(() => props.currency || currencySymbol.value)
const len = computed(() => display.value.length)
const fit = computed(() => (len.value > 13 ? '0.78em' : len.value > 10 ? '0.88em' : undefined))
</script>

<template>
  <div class="money-wrap" :class="wrapClass">
    <input v-bind="inputAttrs" :class="inputClass" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done"
      :value="display" :style="[attrs.style as any, { paddingRight: `${suffix.length * 0.55 + 1.35}em`, fontSize: fit }]"
      @input="onInput" />
    <span class="money-suffix">{{ suffix }}</span>
  </div>
</template>

<style scoped>
.money-wrap {
  position: relative;
  display: inline-block;
  min-width: 0;
  vertical-align: middle;
}
.money-wrap.w-full {
  display: block;
}
.money-wrap > input {
  width: 100%;
  font-variant-numeric: tabular-nums;
}
.money-suffix {
  position: absolute;
  top: 50%;
  right: 0.85em;
  color: var(--muted-foreground);
  font-size: 0.85em;
  pointer-events: none;
  transform: translateY(-50%);
}
</style>
