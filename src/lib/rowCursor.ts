import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

// Jadvalda belgilangan qator — sverka uchun (Panda WMS useRowCursor porti): odam qog'oz
// yoki boshqa fayl bilan solishtirib borayotganda qaysi qatorda turganini yo'qotmaydi.
// Bosilgan qator belgilanadi, ↑/↓ — qo'shni, PgUp/PgDn — 10 tadan, Home/End — chetga,
// Esc — belgini olish, Enter — `onOpen`. Belgi qator KALITIDA (indeksda emas): filtr yoki
// tartib o'zgarsa ham o'sha qator belgili qoladi; ro'yxatdan tushsa — olinadi.
// Matn terilayotganda, modal ochiq bo'lsa yoki modifikator bilan bosilganda tegilmaydi.
// Qator elementida `data-row-key` bo'lishi shart — `container` ichidan shu bilan topiladi.

export const PAGE_STEP = 10

export function nextCursorIndex(current: number, length: number, key: string): number | null {
  if (length === 0 || current < 0) return null
  const last = length - 1
  switch (key) {
    case 'ArrowDown': return Math.min(current + 1, last)
    case 'ArrowUp': return Math.max(current - 1, 0)
    case 'PageDown': return Math.min(current + PAGE_STEP, last)
    case 'PageUp': return Math.max(current - PAGE_STEP, 0)
    case 'Home': return 0
    case 'End': return last
    default: return null
  }
}

function isBusyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest('input, textarea, select, [role="dialog"], [role="listbox"], [role="menu"]')) return true
  // Ochiq modal (POS modallari fixed overlay) — strelka unga tegishli.
  return document.querySelector('.fixed.inset-0') !== null
}

export function useRowCursor<K extends string | number>(
  keys: () => readonly K[],
  container: Ref<HTMLElement | null>,
  onOpen?: (key: K) => void,
) {
  const selected = ref(null) as Ref<K | null>

  const select = (key: K) => { selected.value = key }
  const clear = () => { selected.value = null }
  const isSelected = (key: K) => selected.value === key

  watch(keys, (list) => {
    if (selected.value !== null && !list.includes(selected.value)) clear()
  })

  watch(selected, async (key) => {
    if (key === null) return
    await nextTick()
    container.value?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(String(key))}"]`)?.scrollIntoView({ block: 'nearest' })
  })

  function onKeydown(e: KeyboardEvent) {
    if (selected.value === null || e.defaultPrevented) return
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (isBusyTarget(e.target)) return
    if (e.key === 'Escape') { clear(); return }
    if (e.key === 'Enter') {
      if (!onOpen) return
      // Fokus tugma/havolada bo'lsa Enter ularniki — aks holda bitta bosish ikki ish qilardi.
      if (e.target instanceof HTMLElement && e.target.closest('a, button')) return
      e.preventDefault()
      onOpen(selected.value)
      return
    }
    const list = keys()
    const next = nextCursorIndex(list.indexOf(selected.value), list.length, e.key)
    if (next === null) return
    e.preventDefault()
    selected.value = list[next]
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

  return { selected, select, clear, isSelected }
}

// Davr harakati va Mahsulot harakati bitta davrni bo'lishadi (Panda dateRangeSync kabi):
// birida tanlangan davr ikkinchisini ochganda saqlanadi.
const RANGE_KEY = 'pos_movement_range'

function iso(d: Date): string { return d.toISOString().slice(0, 10) }

export function storedRange(): { from: string; to: string } {
  try {
    const r = JSON.parse(localStorage.getItem(RANGE_KEY) ?? 'null')
    if (r && /^\d{4}-\d{2}-\d{2}$/.test(r.from) && /^\d{4}-\d{2}-\d{2}$/.test(r.to)) return r
  } catch { /* buzilgan yoki ruxsatsiz — standart davr */ }
  const now = new Date()
  return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) }
}

export function saveRange(from: string, to: string): void {
  try { localStorage.setItem(RANGE_KEY, JSON.stringify({ from, to })) } catch { /* e'tiborsiz */ }
}

export function todayIso(): string { return iso(new Date()) }
