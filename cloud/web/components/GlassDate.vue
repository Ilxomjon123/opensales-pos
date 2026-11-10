<script setup lang="ts">
import { computed, ref, useAttrs, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-vue-next'
import GlassSheet from './GlassSheet.vue'

// Native <input type="date"> o'rniga (bulut build'i almashtiradi — vite.config.ts → cloudFields).
// Qiymat o'sha-o'sha 'YYYY-MM-DD' satr ('' = tanlanmagan), `min`/`max`/`required` hurmat qilinadi.
// Kalendar hostel mini app'idagi kabi: haftalar dushanbadan, sarlavha bosilsa — oylar/yil.
defineOptions({ inheritAttrs: false })
const props = defineProps<{ modelValue?: string | null; min?: string; max?: string; required?: boolean | string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: string]; change: [v: string] }>()
const attrs = useAttrs()
const { t, locale } = useI18n()

const ru = computed(() => String(locale.value).startsWith('ru'))
const MONTHS = computed(() => ru.value
  ? ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
  : ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'])
const MONTHS_GEN = computed(() => ru.value
  ? ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
  : ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'])
const WEEK = computed(() => ru.value ? ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] : ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'])
const WEEKDAYS = computed(() => ru.value
  ? ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']
  : ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'])

const pad = (n: number) => String(n).padStart(2, '0')
// Kunlar UTC'da hisoblanadi — soat mintaqasi kunni siljitmasin.
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const parse = (s: string) => new Date(`${s}T00:00:00Z`)
function todayIso() { const n = new Date(); return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}` }
const valid = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)

const value = computed(() => (valid(props.modelValue) ? props.modelValue : ''))
const display = computed(() => {
  if (!value.value) return ''
  const [y, m, d] = value.value.split('-')
  return `${d}.${m}.${y}`
})
const required = computed(() => props.required !== undefined && props.required !== false)
function longLabel(s: string) {
  const d = parse(s)
  const day = d.getUTCDate(), mon = MONTHS_GEN.value[d.getUTCMonth()], wd = WEEKDAYS.value[d.getUTCDay()]
  return ru.value ? `${day} ${mon} ${d.getUTCFullYear()}, ${wd}` : `${day}-${mon} ${d.getUTCFullYear()}, ${wd}`
}

const open = ref(false)
const ym = ref('') // ko'rinayotgan oy 'YYYY-MM'
const monthsView = ref(false)
watch(open, (o) => {
  if (!o) return
  ym.value = (value.value || todayIso()).slice(0, 7)
  monthsView.value = false
})

const outOfRange = (s: string) => (valid(props.min) && s < props.min) || (valid(props.max) && s > props.max)
const cells = computed(() => {
  if (!ym.value) return []
  const first = parse(`${ym.value}-01`)
  const lead = (first.getUTCDay() + 6) % 7
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(first.getTime() + (i - lead) * 86400_000)
    const s = iso(d)
    return s.startsWith(ym.value) ? s : null
  })
})
const year = computed(() => Number(ym.value.slice(0, 4)))
const monthIdx = computed(() => Number(ym.value.slice(5, 7)) - 1)
const headTitle = computed(() => monthsView.value ? String(year.value) : `${MONTHS.value[monthIdx.value]} ${year.value}`)
function go(step: number) {
  if (monthsView.value) { ym.value = `${year.value + step}-${ym.value.slice(5, 7)}`; return }
  const d = new Date(Date.UTC(year.value, monthIdx.value + step, 1))
  ym.value = iso(d).slice(0, 7)
}
function pickMonth(i: number) { ym.value = `${year.value}-${pad(i + 1)}`; monthsView.value = false }

function set(s: string) {
  open.value = false
  if (s === value.value) return
  emit('update:modelValue', s)
  emit('change', s)
}
const today = computed(() => todayIso())
</script>

<template>
  <button type="button" v-bind="attrs" class="glass-field" :disabled="disabled" aria-haspopup="dialog" :aria-expanded="open" @click="open = true">
    <span class="glass-field-value tabular-nums" :class="{ unset: !value }">{{ display || t('cloud.field.date') }}</span>
    <CalendarDays class="glass-field-icon" />
  </button>
  <GlassSheet :open="open" :title="value ? longLabel(value) : t('cloud.field.pickDate')" @close="open = false">
    <div class="glass-cal">
      <div class="glass-cal-head">
        <button type="button" class="glass-cal-nav" :aria-label="t('cloud.field.prev')" @click="go(-1)"><ChevronLeft class="h-5 w-5" /></button>
        <button type="button" class="glass-cal-title" :class="{ open: monthsView }" @click="monthsView = !monthsView">{{ headTitle }}</button>
        <button type="button" class="glass-cal-nav" :aria-label="t('cloud.field.next')" @click="go(1)"><ChevronRight class="h-5 w-5" /></button>
      </div>
      <div v-if="monthsView" class="glass-cal-months">
        <button v-for="(m, i) in MONTHS" :key="m" type="button" class="glass-cal-month"
          :class="{ on: value.slice(0, 7) === `${year}-${pad(i + 1)}`, now: today.slice(0, 7) === `${year}-${pad(i + 1)}` }"
          @click="pickMonth(i)">{{ m }}</button>
      </div>
      <div v-else class="glass-cal-grid" role="grid">
        <div v-for="(w, i) in WEEK" :key="w" class="glass-cal-wd" :class="{ weekend: i >= 5 }">{{ w }}</div>
        <template v-for="(c, i) in cells" :key="i">
          <button v-if="c" type="button" class="glass-cal-day"
            :class="{ on: c === value, now: c === today }" :disabled="outOfRange(c)" @click="set(c)">{{ Number(c.slice(8)) }}</button>
          <div v-else class="glass-cal-day empty" />
        </template>
      </div>
      <div class="glass-cal-foot">
        <button v-if="!required && value" type="button" class="glass-cal-link danger" @click="set('')">{{ t('cloud.field.clear') }}</button>
        <span v-else />
        <button type="button" class="glass-cal-link" :disabled="outOfRange(today)" @click="set(today)">{{ t('cloud.field.today') }}</button>
      </div>
    </div>
  </GlassSheet>
</template>
