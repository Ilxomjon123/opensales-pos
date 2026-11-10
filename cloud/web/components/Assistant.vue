<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Minus, Plus, ShoppingBag, HandCoins, Wallet, PackagePlus, HelpCircle, CheckCircle2, Send, Box, Users, Play, Pause, ChevronLeft, SquarePen, Trash2 } from 'lucide-vue-next'
import { confirmDialog } from '../../../src/lib/confirm'
import SearchableSelect from './SearchableSelect.vue'
import Composer from './Composer.vue'
import MoneyInput from './MoneyInput.vue'
import { api, apiFull, apiRaw, RpcError } from '../rpc'
import { isOwner, session } from '../session'
import { haptic, goToBotChat } from '../telegram'
import { assistant, assistantSaved } from '../assistant'
import { listCustomers, listProducts } from '../lib/db'
import { moneySum, money, currencySymbol } from '../../../src/lib/format'
import { notify } from '../../../src/lib/notify'

// AI yordamchisi (mini app): gapiring yoki yozing → AI tahlil qiladi → shu yerda tekshirib,
// kerak bo'lsa tuzatasiz → "Tasdiqlash" — oddiy kassa amali yoziladi. Har tuzatish serverda
// qayta tekshiriladi (qoldiq, mijoz, huquq) — tugma faqat hammasi joyida bo'lsa yoqiladi.

type Kind = 'sale' | 'payment_in' | 'expense' | 'receipt' | 'product' | 'customer' | 'unknown'
type Person = { name: string; phone: string | null; kind: 'none' | 'debt' | 'credit'; amount: number | null }
type Method = 'cash' | 'card' | 'debt' | 'transfer'
type Opt = { id: number; name: string; unit: string; price: number; stock: number }
type Item = { query: string; productId: number | null; name: string | null; unit: string | null; qty: number; price: number | null; cost: number | null; stock: number | null; options: Opt[] }
type Draft = {
  id: string; kind: Kind; status: 'new' | 'applied' | 'cancelled'; transcript: string; currency: string; source?: string
  customerQuery: string | null; customerId: number | null; customerName: string | null; newCustomer?: string | null
  customerOptions: { id: number; name: string; phone: string | null }[]; walkInId: number | null
  items: Item[]; people: Person[]; method: Method; paid: number | null; amount: number | null; category: string | null
  supplier: string | null; note: string | null; question: string | null; spokenCurrency: string | null
  /** Server taklif qilgan kurs (do'konning oxirgi kursi yoki MB kursi) — narx boshqa valyutada aytilganda. */
  fx?: { from: string; to: string; rate: number; source: 'saved' | 'cbu'; date: string | null } | null
  issues: { code: string; params?: Record<string, unknown> }[]; ready: boolean; total: number; allowed: boolean
  result: Record<string, unknown> | null
}

const { t, locale } = useI18n()
const CATEGORIES = ['Ijara', 'Oylik', 'Kommunal', 'Tovar', 'Transport', 'Soliq', 'Boshqa']

const stage = ref<'input' | 'busy' | 'draft' | 'done'>('input')
const draft = ref<Draft | null>(null)
const saving = ref(false)
const products = ref<{ id: number; name: string; unit: string; price: number; cost_price?: number; stock?: number; is_active?: number }[]>([])
const customers = ref<{ id: number; name: string; phone: string | null; is_walk_in?: number; balance?: number }[]>([])

const openedAt = ref(Date.now())
function reset() {
  stopPlayback()
  revokeVoices()
  openedAt.value = Date.now()
  stage.value = 'input'
  thread.value = []
  micError.value = null
  draft.value = null
  saving.value = false
}
function close() {
  stopPlayback()
  assistant.open = false
  assistant.back = null
}
async function onOpen(o: boolean) {
  if (!o) { assistant.back = null; return }
  assistant.back = back
  reset()
  loadLists()
  if (assistant.draftId) {
    // Bot kartasidan ("Ilovada tuzatish") — to'g'ridan tahrirga; orqaga — chatlar ro'yxati.
    view.value = 'chat'
    chatId.value = null
    items.value = []
    stage.value = 'busy'
    try { show(await api<Draft>('/api/assistant/get', { id: assistant.draftId })) } catch (e) { fail(e); stage.value = 'input' }
    assistant.draftId = null
    return
  }
  // Oxirgi chatni davom ettiramiz (bo'lmasa — yangi chat).
  const last = (() => { try { return localStorage.getItem(LAST_CHAT) } catch { return null } })()
  if (last) await openChat(last)
  else newChat()
}
watch(() => assistant.open, onOpen)
// Bot kartasidan ochilganda (?draft=) App `open`ni bu komponent o'rnatilishidan OLDIN yoqadi — kuzatuvchi
// o'zgarishni ko'rmaydi va qoralama o'rniga salomlashuv chiqardi. onMounted: hamma ref e'lon qilingandan keyin
// (immediate kuzatuvchi `thread` e'lonidan oldin ishlab TDZ xatosi berardi).
onMounted(() => { if (assistant.open) onOpen(true) })

async function loadLists() {
  try {
    const [p, c] = await Promise.all([listProducts(true), listCustomers(true)])
    products.value = p as typeof products.value
    customers.value = c as typeof customers.value
  } catch { /* ro'yxatlar — faqat tanlash uchun */ }
}

function fail(e: unknown) {
  const err = e instanceof RpcError ? e : null
  notify(err ? t(err.code, err.params) : String(e), 'error')
  haptic('error')
}

// ---- Chatlar: ro'yxat, ochish, yangi, o'chirish ---------------------------------------------
type Voice = { ms: number; wave: number[] }
type Reply = { kind: 'text'; text: string } | { kind: 'card'; html: string; status: 'open' | 'saved' | 'cancelled' | 'replaced' | 'expired'; ready: boolean; convert: number | null; kindName: Kind }
type ChatItem = { id: string; at: string; user: { kind: 'text' | 'voice'; text: string; voice: Voice | null }; reply: Reply }
type ChatRow = { id: string; title: string; updated_at: string; last: string | null; count: number }
const LAST_CHAT = 'kassa:ai:chat'
const view = ref<'list' | 'chat'>('chat')
const chatId = ref<string | null>(null)
const chatTitle = ref('')
const items = ref<ChatItem[]>([])
const chats = ref<ChatRow[]>([])
const chatsLoading = ref(false)
/** Shu seansda yozilgan ovozlar (qoralama id → blob URL) — tarixdagi ovozni ham tinglash uchun. */
const voiceUrls = new Map<string, string>()
/** Shu seansda kelgan javoblar — faqat ular animatsiya bilan paydo bo'ladi (tarix ochilganda hammasi sakramaydi). */
const fresh = ref(new Set<string>())
const lang = () => (locale.value === 'ru' ? 'ru' : 'uz')
function rememberChat(id: string | null) {
  try { if (id) localStorage.setItem(LAST_CHAT, id); else localStorage.removeItem(LAST_CHAT) } catch { /* */ }
}
async function loadChats() {
  chatsLoading.value = true
  try { chats.value = await api<ChatRow[]>('/api/assistant/chats') } catch (e) { fail(e) } finally { chatsLoading.value = false }
}
// Chat ochilishi Telegram'dagidek: darhol OXIRIDA (tepasi chizilib, keyin pastga aylanib tushmaydi — 2026-11-09
// user videosi). Ochilgan chat xotirada — qayta kirilganda keshdan darhol, serverdan jim yangilanadi; birinchi
// marta — yuklanguncha chat ko'rinmaydi (salomlashuv → tarix almashinuvi miltillamasin).
const chatCache = new Map<string, ChatItem[]>()
const chatLoading = ref(false)
/** Keyingi o'zgarishda oxiriga aylantirish sakrashsiz (yuklash), aks holda — yangi xabar, silliq. */
let jumpToEnd = false
async function openChat(id: string) {
  view.value = 'chat'
  stage.value = 'input'
  chatId.value = id
  chatTitle.value = chats.value.find((c) => c.id === id)?.title ?? ''
  thread.value = []
  const cached = chatCache.get(id)
  jumpToEnd = true
  items.value = cached ?? []
  chatLoading.value = !cached
  void nextTick(() => toEnd(false))
  try {
    const latest = await api<ChatItem[]>('/api/assistant/chat', { id, lang: lang() })
    if (chatId.value !== id) return
    if (JSON.stringify(latest) !== JSON.stringify(items.value)) {
      const c = chatEl.value
      const atEnd = !c || chatLoading.value || c.scrollHeight - c.scrollTop - c.clientHeight < 48
      jumpToEnd = true
      items.value = latest
      if (atEnd) { await nextTick(); toEnd(false) }
    }
    jumpToEnd = false
    chatCache.set(id, items.value)
    if (!chatTitle.value) chatTitle.value = items.value[0]?.user.text.slice(0, 60) ?? ''
    rememberChat(id)
  } catch {
    // Chat o'chirilgan/topilmadi — yangisi.
    chatCache.delete(id)
    newChat()
  } finally {
    chatLoading.value = false
    jumpToEnd = false
  }
}
async function reloadChat() {
  if (!chatId.value) return
  try { items.value = await api<ChatItem[]>('/api/assistant/chat', { id: chatId.value, lang: lang() }) } catch { /* */ }
}
function newChat() {
  view.value = 'chat'
  stage.value = 'input'
  chatId.value = null
  chatTitle.value = ''
  items.value = []
  thread.value = []
  rememberChat(null)
  haptic('select')
}
async function showList() {
  view.value = 'list'
  stage.value = 'input'
  await loadChats()
}
async function deleteChat() {
  const id = chatId.value
  if (!id || !(await confirmDialog(t('cloud.ai.deleteChat') + '?', { danger: true }))) return
  try { await api('/api/assistant/chat-delete', { id }); rememberChat(null); haptic('success'); await showList() } catch (e) { fail(e) }
}
/** Orqaga: tahrir → chat; chat → ro'yxat; ro'yxat → yopish (Telegram BackButton ham shu). */
function back() {
  if (stage.value === 'draft' || stage.value === 'done') { stage.value = 'input'; draft.value = null; void reloadChat(); return }
  if (view.value === 'chat') { void showList(); return }
  close()
}
const rowTime = (iso: string) => {
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString() ? hhmm(d.getTime()) : d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }).replace('/', '.')
}

// ---- Karta tugmalari (botdagidek): tasdiqlash, kurs bilan saqlash, tahrirlash, bekor qilish
const acting = ref<string | null>(null)
async function applyItem(it: ChatItem, rate: number | null = null) {
  if (acting.value) return
  acting.value = it.id
  const r = await apiFull<Draft>('/api/assistant/apply', rate ? { id: it.id, edits: { rate } } : { id: it.id })
  acting.value = null
  if (r.ok) { haptic('success'); assistantSaved() } else fail(r.error)
  await reloadChat()
}
async function cancelItem(it: ChatItem) {
  if (acting.value) return
  acting.value = it.id
  try { await api('/api/assistant/cancel', { id: it.id }); haptic('select') } catch (e) { fail(e) }
  acting.value = null
  await reloadChat()
}
async function editItem(it: ChatItem) {
  try {
    const d = await api<Draft>('/api/assistant/get', { id: it.id })
    draft.value = d
    stage.value = d.status === 'applied' ? 'done' : 'draft'
  } catch (e) { fail(e) }
}
/** Server javobidagi xabar juftligi chatga qo'shiladi (yangi chat bo'lsa — id eslab qolinadi). */
function accept(res: Draft & { item?: ChatItem; chatId?: string }, localVoice: string | null) {
  if (res.chatId && res.chatId !== chatId.value) { chatId.value = res.chatId; rememberChat(res.chatId) }
  if (!chatTitle.value) chatTitle.value = res.transcript.slice(0, 60)
  if (res.item) {
    if (localVoice) voiceUrls.set(res.item.id, localVoice)
    fresh.value.add(res.item.id)
    items.value.push(res.item)
  }
  thread.value = []
  stage.value = 'input'
}

function show(d: Draft) {
  // Tushunilmagan xabar — tasdiqlash kartasi emas, suhbatdagi javob: yordamchi savol beradi, qayta aytasiz.
  // Tovar aytilmagan (masalan, "10 ta test mahsulot") — bo'sh karta emas, savol.
  const empty = ((d.kind === 'sale' || d.kind === 'receipt' || d.kind === 'product') && d.items.length === 0) || (d.kind === 'customer' && !(d.people ?? []).length)
  if (d.kind === 'unknown' || empty) {
    thread.value.push({ from: 'ai', text: d.question || t('cloud.ai.unknownHint'), at: Date.now() })
    stage.value = 'input'
    return
  }
  draft.value = d
  stage.value = d.status === 'applied' ? 'done' : 'draft'
}

// ---- Kiritish: Telegram'dagi kabi suhbat (Composer — matn yoki bosib turib ovoz) -----------

type Sent = { kind: 'text'; text: string } | { kind: 'voice'; ms: number; wave: number[]; url: string }
type Msg = ({ from: 'me'; sent: Sent } | { from: 'ai'; text: string }) & { at: number }
/** Suhbat (Telegram kabi): sizning xabarlaringiz va yordamchining javoblari. */
const thread = ref<Msg[]>([])
const micError = ref<'denied' | 'unsupported' | null>(null)
// Yangi xabar / "yozmoqda…" / xato — suhbat oxiriga silliq aylanadi (Telegram kabi).
const chatEl = ref<HTMLElement | null>(null)
function toEnd(smooth: boolean) {
  const c = chatEl.value
  if (!c) return
  if (smooth) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' })
  else c.scrollTop = c.scrollHeight
}
// flush 'post' — DOM yangilangach, ekran chizilishidan OLDIN: chat oynasi yangi paydo bo'lsa yoki tarix yuklansa —
// birdaniga oxirida; suhbat davomidagi yangi xabar / "yozmoqda" / xato — silliq.
watch(chatEl, (el) => { if (el) toEnd(false) }, { flush: 'post' })
watch(() => [thread.value.length, items.value.length, stage.value, micError.value], () => {
  if (!jumpToEnd) toEnd(true)
}, { flush: 'post' })
// Joriy chatning so'nggi holati keshda (yangi xabarlar, tasdiqlash/bekor holatlari).
watch(items, (v) => { if (chatId.value && v.length) chatCache.set(chatId.value, v) }, { deep: true })

// Suzuvchi yozish paneli (Telegram kabi): chat butun balandlikda aylanadi, panel ustida turadi. Chat pastki
// bo'shlig'i = panel balandligi (ko'p qatorli matnda o'sadi); oxirida turgan bo'lsa — oxirida qoladi.
const floatEl = ref<HTMLElement | null>(null)
const floatH = ref(64)
let floatRo: ResizeObserver | null = null
watch(floatEl, (el) => {
  floatRo?.disconnect()
  floatRo = null
  if (!el || typeof ResizeObserver === 'undefined') return
  floatRo = new ResizeObserver(() => {
    const c = chatEl.value
    const atEnd = !c || c.scrollHeight - c.scrollTop - c.clientHeight < 24
    floatH.value = Math.ceil(el.getBoundingClientRect().height)
    if (atEnd) void nextTick(() => chatEl.value?.scrollTo({ top: chatEl.value.scrollHeight }))
  })
  floatRo.observe(el)
})

async function sendText(value: string) {
  const v = value.trim()
  if (!v) return
  micError.value = null
  thread.value.push({ from: 'me', sent: { kind: 'text', text: v }, at: Date.now() })
  stage.value = 'busy'
  try { accept(await api<Draft & { item?: ChatItem; chatId?: string }>('/api/assistant/parse', { text: v, chatId: chatId.value ?? '', lang: lang() }), null) } catch (e) { failed(e) }
}
/** Yuborilmadi (limit, tarmoq…) — xabar qoladi, ostida yordamchining xato javobi (Telegram'dagi "!" o'rniga). */
function failed(e: unknown) {
  const err = e instanceof RpcError ? e : null
  thread.value.push({ from: 'ai', text: err ? t(err.code, err.params) : String(e), at: Date.now() })
  haptic('error')
  stage.value = 'input'
}
async function sendVoice(v: { blob: Blob; type: string; ms: number; wave: number[] }) {
  micError.value = null
  const url = URL.createObjectURL(v.blob)
  thread.value.push({ from: 'me', sent: { kind: 'voice', ms: v.ms, wave: v.wave, url }, at: Date.now() })
  stage.value = 'busy'
  try {
    const headers = { 'X-Chat-Id': chatId.value ?? '', 'X-Voice': JSON.stringify({ ms: Math.round(v.ms), wave: v.wave }), 'X-Lang': lang() }
    accept(await apiRaw<Draft & { item?: ChatItem; chatId?: string }>('/api/assistant/parse', v.blob, v.type, headers), url)
  } catch (e) { failed(e) }
}
function voiceToBot() {
  if (session.bot) goToBotChat(session.bot)
}
const voiceLen = (ms: number, min = 1) => { const s = Math.max(min, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

// ---- Yuborilgan ovozni tinglash (Telegram kabi: ▶︎/❚❚, to'lqin bo'ylab progress) ----------------
// Yozuv qurilmada qoladi (blob URL) — serverga qayta so'rov yo'q; suhbat tozalanganda bo'shatiladi.
const playing = ref<{ n: number; paused: boolean } | null>(null)
const progress = ref(0)
let audioEl: HTMLAudioElement | null = null
let playRaf = 0
function stopPlayback() {
  cancelAnimationFrame(playRaf)
  audioEl?.pause()
  playing.value = null
  progress.value = 0
}
function followProgress(ms: number) {
  cancelAnimationFrame(playRaf)
  // MediaRecorder webm'ida davomiylik yozilmaydi (duration = Infinity) — o'zimiz o'lchagan ms bo'yicha.
  const step = () => {
    if (!audioEl || !playing.value || playing.value.paused) return
    progress.value = Math.min(1, (audioEl.currentTime * 1000) / Math.max(ms, 1))
    playRaf = requestAnimationFrame(step)
  }
  playRaf = requestAnimationFrame(step)
}
function togglePlay(n: number, s: { url: string; ms: number }) {
  haptic('select')
  const cur = playing.value
  if (cur && cur.n === n) {
    if (cur.paused) { cur.paused = false; void audioEl?.play(); followProgress(s.ms) }
    else { cur.paused = true; audioEl?.pause(); cancelAnimationFrame(playRaf) }
    return
  }
  stopPlayback()
  const a = (audioEl ??= new Audio())
  a.onended = stopPlayback
  a.onerror = stopPlayback
  a.src = s.url
  playing.value = { n, paused: false }
  a.play().then(() => followProgress(s.ms)).catch(stopPlayback)
}
function revokeVoices() {
  for (const m of thread.value) if (m.from === 'me' && m.sent.kind === 'voice') URL.revokeObjectURL(m.sent.url)
}
onBeforeUnmount(() => { stopPlayback(); revokeVoices(); floatRo?.disconnect() })
/** Qoralama shu yerda yuborilgan ovozdan bo'lsa — uni qoralama ko'rinishida ham tinglash mumkin. */
const lastVoice = computed(() => {
  if (draft.value?.source !== 'voice') return null
  for (let n = thread.value.length - 1; n >= 0; n--) {
    const m = thread.value[n]
    if (m.from === 'me' && m.sent.kind === 'voice') return { n, sent: m.sent }
  }
  return null
})

// ---- Qoralama: tuzatish → serverda qayta baholash -----------------------------------------

function edits(d: Draft) {
  if (d.kind === 'customer') return { people: d.people }
  if (d.kind === 'product') {
    return { newItems: d.items.map((i) => ({ name: i.name ?? '', price: i.price, cost: i.cost, unit: i.unit, qty: i.qty ?? 0 })), note: d.note }
  }
  return {
    customerId: d.customerId,
    newCustomer: d.newCustomer ?? null,
    items: d.items.filter((i) => i.productId).map((i) => ({ productId: i.productId!, qty: i.qty, price: i.price })),
    method: d.method,
    paid: d.paid,
    amount: d.amount,
    category: d.category,
    supplier: d.supplier,
    note: d.note,
  }
}

let syncTimer = 0
function changed() {
  clearTimeout(syncTimer)
  syncTimer = window.setTimeout(sync, 250)
}
async function sync() {
  syncTimer = 0
  const d = draft.value
  if (!d || d.status !== 'new') return
  const r = await apiFull<Draft>('/api/assistant/update', { id: d.id, edits: edits(d) })
  // Foydalanuvchi shu orada yana o'zgartirgan bo'lsa — eski javob ustiga yozmaymiz (keyingisi keladi).
  if (syncTimer || !r.ok || draft.value?.id !== d.id) return
  // Yangi tovarlarda hamma qator serverga ketadi (id'siz) — server javobi to'liq; sotuv/kirimda esa
  // hali tanlanmagan qatorlar serverga yuborilmaydi, ularni saqlab qolamiz.
  draft.value = { ...r.data, items: r.data.kind === 'product' ? r.data.items : mergeItems(r.data.items, draft.value.items) }
}
/** Server javobidagi elementlar + hali tanlanmagan (productId'siz) qatorlar (ular serverga yuborilmaydi). */
function mergeItems(server: Item[], local: Item[]): Item[] {
  return [...server, ...local.filter((i) => !i.productId)]
}

function pickProduct(it: Item, id: number | string | null) {
  const p = id == null ? null : products.value.find((x) => x.id === Number(id)) ?? it.options.find((o) => o.id === Number(id))
  if (!p) return
  it.productId = p.id
  it.name = p.name
  it.unit = p.unit
  it.price = draft.value?.kind === 'receipt' ? it.price : Math.round(p.price)
  haptic('select')
  changed()
}
function addProduct(id: number | string | null) {
  const d = draft.value
  const p = products.value.find((x) => x.id === Number(id))
  if (!d || !p) return
  const same = d.items.find((i) => i.productId === p.id)
  if (same) same.qty += 1
  else d.items.push({ query: p.name, productId: p.id, name: p.name, unit: p.unit, qty: 1, price: d.kind === 'receipt' ? null : Math.round(p.price), cost: null, stock: null, options: [] })
  changed()
}
function removeItem(i: number) { draft.value?.items.splice(i, 1); changed() }
/** Tanlanmagan (❓) qator bo'lsa tasdiqlab bo'lmaydi — server uni ko'rmaydi, lekin u hali ro'yxatda. */
const unresolved = computed(() => (draft.value?.kind === 'sale' || draft.value?.kind === 'receipt') && !!draft.value?.items.some((i) => !i.productId))
function addPerson() {
  draft.value?.people.push({ name: '', phone: null, kind: 'none', amount: null })
}
function removePerson(i: number) { draft.value?.people.splice(i, 1); changed() }
function addRow() {
  draft.value?.items.push({ query: '', productId: null, name: '', unit: 'dona', qty: 0, price: null, cost: null, stock: null, options: [] })
}
const canConfirm = computed(() => !!draft.value?.ready && !unresolved.value && !saving.value)
function step(it: Item, by: number) { it.qty = Math.max(1, Math.round((it.qty + by) * 1000) / 1000); haptic('select'); changed() }
function pickCustomer(id: number | string | null) {
  const d = draft.value
  if (!d) return
  d.customerId = id == null ? null : Number(id)
  d.customerName = customers.value.find((c) => c.id === d.customerId)?.name ?? null
  if (d.customerId) d.newCustomer = null
  changed()
}
/** Aytilgan nom bilan yangi mijoz (tasdiqlashda yaratiladi) — o'xshash mijozlar bo'lsa ham ega tanlay oladi. */
function useNewCustomer() {
  const d = draft.value
  if (!d?.customerQuery) return
  d.newCustomer = d.customerQuery
  d.customerId = null
  d.customerName = null
  haptic('select')
  changed()
}

const customerItems = computed(() => customers.value
  .filter((c) => draft.value?.kind === 'sale' || !c.is_walk_in)
  .map((c) => ({ value: c.id, label: c.is_walk_in ? t('cloud.ai.walkIn') : c.phone ? `${c.name} · ${c.phone}` : c.name })))
const productItems = computed(() => products.value.map((p) => ({ value: p.id, label: p.name })))
const methods = computed<Method[]>(() => draft.value?.kind === 'payment_in' ? ['cash', 'card', 'transfer'] : ['cash', 'card', 'debt'])
const priceEditable = computed(() => draft.value?.kind === 'receipt' || isOwner())
const KIND_ICON = { sale: ShoppingBag, payment_in: HandCoins, expense: Wallet, receipt: PackagePlus, product: Box, customer: Users, unknown: HelpCircle }
const issueText = (i: { code: string; params?: Record<string, unknown> }) => t(`cloud.ai.issue.${i.code}`, (i.params ?? {}) as Record<string, unknown>)
const qty = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString(locale.value === 'ru' ? 'ru-RU' : 'uz-UZ')

async function confirmDraft() {
  const d = draft.value
  if (!d || !canConfirm.value) return
  saving.value = true
  clearTimeout(syncTimer)
  const r = await apiFull<Draft>('/api/assistant/apply', { id: d.id, edits: edits(d) })
  saving.value = false
  if (r.ok) {
    draft.value = r.data
    haptic('success')
    assistantSaved()
    // Chatdan ochilgan bo'lsa — chatga qaytamiz (karta "Saqlandi" bo'ladi), bot havolasidan — natija ekrani.
    if (chatId.value) { stage.value = 'input'; draft.value = null; await reloadChat() } else stage.value = 'done'
    return
  }
  fail(r.error)
  const next = r.extra.draft as Draft | undefined
  if (next) draft.value = next
}
async function cancelDraft() {
  const d = draft.value
  if (d?.status === 'new') await api('/api/assistant/cancel', { id: d.id }).catch(() => {})
  stage.value = 'input'
  draft.value = null
  await reloadChat()
}

// ---- Valyuta: narx boshqa valyutada aytilgan (USD) — o'sha valyutada ko'rsatamiz, kurs bilan o'tkazamiz.
const SYM: Record<string, string> = { USD: '$', EUR: '€', RUB: '₽', KZT: '₸', UZS: "so'm" }
const spoken = computed(() => {
  const d = draft.value
  return d?.spokenCurrency && d.issues.some((i) => i.code === 'currencyMismatch') ? d.spokenCurrency : null
})
const dispCur = computed(() => (spoken.value ? SYM[spoken.value] ?? spoken.value : undefined))
const showMoney = (n: number) => (dispCur.value ? (spoken.value === 'USD' || spoken.value === 'EUR' ? dispCur.value + money(n) : `${money(n)} ${dispCur.value}`) : moneySum(n))
const rate = ref<number | ''>('')
// Kurs taklifi serverdan: do'konning oxirgi kursi (bot chatidagi bilan bir xil) yoki MB kursi.
watch(spoken, (c) => { if (c) rate.value = draft.value?.fx?.rate ?? '' }, { immediate: true })
const converting = ref(false)
/** Narx/summalarni kurs bo'yicha do'kon valyutasiga o'tkazish — serverda (katalog narxlari tegilmaydi, kurs eslab qolinadi). */
async function convert() {
  const d = draft.value
  const r = Number(rate.value)
  if (!d || !spoken.value || !(r > 0) || converting.value) return
  converting.value = true
  // Kutilayotgan tuzatishlar avval serverga — aks holda server eski holatni o'tkazadi.
  if (syncTimer) { clearTimeout(syncTimer); await sync() }
  const cur = draft.value
  const res = cur?.id === d.id ? await apiFull<Draft>('/api/assistant/update', { id: d.id, edits: { rate: r } }) : null
  converting.value = false
  if (!res || draft.value?.id !== d.id) return
  if (!res.ok) { fail(res.error); return }
  draft.value = { ...res.data, items: res.data.kind === 'product' ? res.data.items : mergeItems(res.data.items, draft.value.items) }
  haptic('success')
}

const resultText = computed(() => {
  const d = draft.value
  const r = d?.result ?? {}
  if (!d) return ''
  if (d.kind === 'sale') {
    const base = t('cloud.ai.savedSale', { no: r.receiptNumber, total: moneySum(Number(r.total ?? 0)) })
    return Number(r.debt) > 0 ? `${base} · ${t('cloud.ai.savedDebt', { debt: moneySum(Number(r.debt)) })}` : base
  }
  if (d.kind === 'product') return t('cloud.ai.savedProducts', { n: Number(r.count ?? d.items.length) })
  if (d.kind === 'customer') return t('cloud.ai.savedCustomers', { n: Number(r.count ?? d.people.length) })
  if (d.kind === 'receipt') return t('cloud.ai.savedReceipt', { no: r.receiptNumber, total: moneySum(Number(r.total ?? 0)) })
  return t('cloud.ai.savedAmount', { amount: moneySum(Number(r.amount ?? d.amount ?? 0)) })
})
// Namunalar — xabar pufagi EMAS (go'yo oldin yozishilgandek tuyulmasin): "Masalan:" ostida amal ikonkali kichik chiplar.
// ---- Telegram suhbati: vaqt (HH:MM), "dum" faqat bir xil yuboruvchining oxirgi xabarida.
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const tailAt = (n: number) => n === thread.value.length - 1 || thread.value[n + 1].from !== thread.value[n].from
const greetTail = computed(() => !thread.value.length || thread.value[0].from === 'me')
const EMOJI = new Map<unknown, string>([[ShoppingBag, '🧾'], [HandCoins, '💵'], [Wallet, '💸'], [PackagePlus, '📦'], [Box, '🆕']])

// Har do'konga o'zining namunalari: haqiqiy tovar, mijoz va narxlardan (katalog bo'sh bo'lsa — umumiy namunalar).
// Narx og'zaki ko'rinishda ("400 ming", "1,5 mln") — odam shunday aytadi va AI shunday tushunadi.
function spokenMoney(n: number): string {
  const ru = locale.value === 'ru'
  const dec = (x: number) => String(Math.round(x * 10) / 10).replace('.', ',')
  if (n >= 1_000_000) return `${dec(n / 1_000_000)} ${ru ? 'млн' : 'mln'}`
  if (n >= 1000) return `${Math.round(n / 1000)} ${ru ? 'тыс.' : 'ming'}`
  return String(Math.round(n))
}
/** Og'zaki aytishga qulay yaxlit summa: 1 234 567 → 1 200 000, 47 300 → 47 000. */
function niceRound(n: number): number {
  const step = n >= 1_000_000 ? 100_000 : n >= 100_000 ? 10_000 : 1000
  return Math.max(step, Math.round(n / step) * step)
}
const examples = computed(() => {
  // Nomi qisqa (chipga sig'adigan), faol, qoldig'i bor tovarlar; mijozlar — yo'l-yo'lakaydan tashqari.
  const prods = products.value.filter((p) => p.is_active !== 0 && p.name.length <= 26)
  const inStock = prods.filter((p) => (p.stock ?? 1) > 0)
  const pA = inStock[0] ?? prods[0]
  const pB = prods.find((p) => p.id !== pA?.id) ?? pA
  const people = customers.value.filter((c) => !c.is_walk_in && c.name.length <= 20)
  const debtor = people.find((c) => (c.balance ?? 0) < 0)
  const cust = people[0]
  const sale = pA
    ? { text: cust
        ? t('cloud.ai.exSaleDebt', { customer: cust.name, qty: (pA.stock ?? 2) >= 2 ? 2 : 1, product: pA.name })
        : t('cloud.ai.exSaleCash', { qty: (pA.stock ?? 2) >= 2 ? 2 : 1, product: pA.name }), icon: ShoppingBag }
    : { text: t('cloud.ai.e1'), icon: ShoppingBag }
  const payer = debtor ?? cust
  const pay = payer
    ? { text: t('cloud.ai.exPay', { customer: payer.name, amount: spokenMoney(debtor ? niceRound(Math.abs(debtor.balance ?? 0) / 2) : 50_000) }), icon: HandCoins }
    : { text: t('cloud.ai.e2'), icon: HandCoins }
  const cost = pB ? (pB.cost_price && pB.cost_price > 0 ? pB.cost_price : pB.price * 0.8) : 0
  const receipt = pB && cost > 0
    ? { text: t('cloud.ai.exReceipt', { qty: 10, product: pB.name, amount: spokenMoney(niceRound(cost)) }), icon: PackagePlus }
    : { text: t('cloud.ai.e4'), icon: PackagePlus }
  if (!isOwner()) {
    // Kassir — faqat sotuv: ikkinchi tovar bilan naqd sotuv namunasi.
    const second = pB && pB.id !== pA?.id ? { text: t('cloud.ai.exSaleCash', { qty: 1, product: pB.name }), icon: ShoppingBag } : null
    return second ? [sale, second] : [sale]
  }
  return [sale, pay, { text: t('cloud.ai.e3'), icon: Wallet }, receipt, { text: t('cloud.ai.e5'), icon: Box }]
})
</script>

<template>
  <Teleport to="body">
  <Transition name="ai-screen">
  <div v-if="assistant.open" class="ai-screen">
    <!-- Telegram chat sarlavhasi: ← orqaga, nom + holat, o'ngda amal -->
    <header class="ai-head">
      <button type="button" class="ai-head-btn" :aria-label="$t('common.back')" @click="haptic('select'); back()"><ChevronLeft class="h-6 w-6" /></button>
      <div class="ai-head-avatar">S</div>
      <div class="min-w-0 flex-1">
        <div class="ai-head-name">{{ view === 'list' && stage !== 'draft' ? $t('cloud.ai.chats') : chatTitle || $t('cloud.ai.title') }}</div>
        <div class="ai-head-sub" :class="{ busy: stage === 'busy' }">
          <template v-if="stage === 'busy'">{{ $t('cloud.ai.typingWord') }}<span class="tg-hdots"><i /><i /><i /></span></template>
          <template v-else>{{ $t('cloud.ai.botStatus') }}</template>
        </div>
      </div>
      <button v-if="view === 'list' && stage !== 'draft'" type="button" class="ai-head-btn" :aria-label="$t('cloud.ai.newChat')" @click="newChat"><SquarePen class="h-5 w-5" /></button>
      <button v-else-if="chatId && stage === 'input'" type="button" class="ai-head-btn" :aria-label="$t('cloud.ai.deleteChat')" @click="deleteChat"><Trash2 class="h-5 w-5" /></button>
    </header>
    <div class="ai-body" :class="{ floating: view !== 'list' && (stage === 'input' || stage === 'busy') }" :style="{ '--float-h': `${floatH}px` }">
      <!-- 0) Chatlar ro'yxati (Telegram chatlar ro'yxati kabi) -->
      <template v-if="view === 'list' && stage !== 'draft' && stage !== 'done'">
        <div class="ai-list">
          <button type="button" class="ai-list-new" @click="newChat"><SquarePen class="h-5 w-5" /> {{ $t('cloud.ai.newChat') }}</button>
          <div v-if="chatsLoading && !chats.length" class="space-y-2 p-2"><div v-for="i in 4" :key="i" class="h-14 animate-pulse rounded-xl bg-muted" /></div>
          <button v-for="c in chats" :key="c.id" type="button" class="ai-list-row" @click="haptic('select'); openChat(c.id)">
            <div class="ai-list-ava">{{ (c.title || '?').slice(0, 1).toUpperCase() }}</div>
            <div class="min-w-0 flex-1 text-left">
              <div class="flex items-baseline gap-2">
                <span class="min-w-0 flex-1 truncate font-semibold">{{ c.title }}</span>
                <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ rowTime(c.updated_at) }}</span>
              </div>
              <div class="truncate text-sm text-muted-foreground">{{ c.last ?? '' }}</div>
            </div>
          </button>
          <div v-if="!chatsLoading && !chats.length" class="p-8 text-center text-sm text-muted-foreground">{{ $t('cloud.ai.noChats') }}</div>
        </div>
      </template>
      <!-- 1–2) Suhbat (Telegram kabi): yordamchi pufagi, sizning xabaringiz, "yozmoqda…" -->
      <template v-else-if="stage === 'input' || stage === 'busy'">
        <!-- Telegram suhbati: fon naqshi, "Bugun", pufaklar (dum, vaqt, ✓✓), xabar ostidagi inline tugmalar. -->
        <div ref="chatEl" class="ai-chat tg-chat" :class="{ loading: chatLoading }">
          <div class="tg-date"><span>{{ $t('cloud.ai.today') }}</span></div>
          <div class="tg-row in" :class="{ anim: !items.length }">
            <div class="tg-bubble in" :class="{ tail: greetTail }">
              {{ $t('cloud.ai.greeting') }}<span class="tg-spacer" /><span class="tg-meta">{{ hhmm(openedAt) }}</span>
            </div>
          </div>
          <!-- Saqlangan tarix: foydalanuvchi xabari + yordamchi javobi/kartasi (botdagidek, tugmalari bilan) -->
          <template v-for="it in items" :key="it.id">
            <div class="tg-row out">
              <div class="tg-bubble out tail" :class="{ voice: it.user.kind === 'voice' }">
                <template v-if="it.user.kind === 'text'">{{ it.user.text }}</template>
                <template v-else>
                  <div class="ai-voice">
                    <button v-if="voiceUrls.has(it.id)" type="button" class="ai-voice-ico" @click="togglePlay(1000 + items.indexOf(it), { url: voiceUrls.get(it.id)!, ms: it.user.voice?.ms ?? 0 })">
                      <Pause v-if="playing?.n === 1000 + items.indexOf(it) && !playing.paused" class="h-4 w-4" />
                      <Play v-else class="h-4 w-4 translate-x-px" />
                    </button>
                    <span class="ai-wave"><i v-for="(h, i) in (it.user.voice?.wave ?? [])" :key="i" :style="{ height: `${4 + h * 18}px` }" /></span>
                    <span class="ai-dur">{{ voiceLen(it.user.voice?.ms ?? 0) }}</span>
                  </div>
                  <div class="tg-transcript">{{ it.user.text }}</div>
                </template>
                <span class="tg-spacer wide" /><span class="tg-meta">{{ hhmm(Date.parse(it.at)) }} <span class="tg-ticks">✓✓</span></span>
              </div>
            </div>
            <div class="tg-row in" :class="{ anim: fresh.has(it.id) }">
              <div v-if="it.reply.kind === 'text'" class="tg-bubble in tail">{{ it.reply.text || $t('cloud.ai.unknownHint') }}<span class="tg-spacer" /><span class="tg-meta">{{ hhmm(Date.parse(it.at)) }}</span></div>
              <!-- eslint-disable-next-line vue/no-v-html -- server botdagi kartani yasaydi, hamma satr escape qilingan -->
              <div v-else class="tg-bubble in tail tg-card" :class="it.reply.status"><span v-html="it.reply.html" /><span class="tg-spacer" /><span class="tg-meta">{{ hhmm(Date.parse(it.at)) }}</span></div>
            </div>
            <div v-if="it.reply.kind === 'card' && it.reply.status === 'open'" class="tg-kb" :class="{ busy: acting === it.id, anim: fresh.has(it.id) }">
              <div v-if="it.reply.ready" class="tg-kb-row">
                <button type="button" class="tg-kb-btn" @click="applyItem(it)">{{ $t('cloud.ai.kbConfirm') }}</button>
                <button type="button" class="tg-kb-btn" @click="cancelItem(it)">{{ $t('cloud.ai.kbCancel') }}</button>
              </div>
              <button v-else-if="it.reply.convert" type="button" class="tg-kb-btn" @click="applyItem(it, it.reply.kind === 'card' ? it.reply.convert : null)">{{ $t('cloud.ai.kbConvert', { shop: currencySymbol }) }}</button>
              <div class="tg-kb-row">
                <button type="button" class="tg-kb-btn" @click="editItem(it)">{{ it.reply.ready ? $t('cloud.ai.kbEdit') : $t('cloud.ai.kbFix') }}</button>
                <button v-if="!it.reply.ready" type="button" class="tg-kb-btn" @click="cancelItem(it)">{{ $t('cloud.ai.kbCancel') }}</button>
              </div>
            </div>
          </template>
          <div v-if="!thread.length && !items.length" class="tg-kb">
            <button v-for="e in examples" :key="e.text" type="button" class="tg-kb-btn" @click="haptic('select'); sendText(e.text)">
              {{ EMOJI.get(e.icon) }} {{ e.text }}
            </button>
          </div>
          <template v-for="(m, n) in thread" :key="n">
            <div v-if="m.from === 'me'" class="tg-row out anim">
              <div class="tg-bubble out" :class="{ tail: tailAt(n), voice: m.sent.kind === 'voice' }">
                <template v-if="m.sent.kind === 'text'">{{ m.sent.text }}</template>
                <div v-else class="ai-voice">
                  <button type="button" class="ai-voice-ico" :aria-label="playing?.n === n && !playing.paused ? $t('cloud.ai.pause') : $t('cloud.ai.play')" @click="togglePlay(n, m.sent)">
                    <Pause v-if="playing?.n === n && !playing.paused" class="h-4 w-4" />
                    <Play v-else class="h-4 w-4 translate-x-px" />
                  </button>
                  <span class="ai-wave"><i v-for="(h, i) in m.sent.wave" :key="i" :class="{ dim: playing?.n === n && (i + 0.5) / m.sent.wave.length > progress }" :style="{ height: `${4 + h * 18}px` }" /></span>
                  <span class="ai-dur">{{ playing?.n === n ? voiceLen(progress * m.sent.ms, 0) : voiceLen(m.sent.ms) }}</span>
                </div>
                <span class="tg-spacer wide" /><span class="tg-meta">{{ hhmm(m.at) }} <span class="tg-ticks">✓✓</span></span>
              </div>
            </div>
            <div v-else class="tg-row in anim">
              <div class="tg-bubble in" :class="{ tail: tailAt(n) }">{{ m.text }}<span class="tg-spacer" /><span class="tg-meta">{{ hhmm(m.at) }}</span></div>
            </div>
          </template>
          <div v-if="stage === 'busy'" class="tg-row in anim">
            <div class="tg-bubble in tail tg-typing" :aria-label="$t('cloud.ai.typing')"><i /><i /><i /></div>
          </div>
          <div v-if="micError" class="tg-row in anim">
            <div class="tg-bubble in tail warn">
              {{ micError === 'denied' ? $t('cloud.ai.micDenied') : $t('cloud.ai.micUnsupported') }}
            </div>
          </div>
          <div v-if="micError && session.bot" class="tg-kb">
            <button type="button" class="tg-kb-btn" @click="voiceToBot"><Send class="inline h-4 w-4 align-[-3px]" /> {{ $t('cloud.ai.sendToBot') }}</button>
          </div>
        </div>
        <div ref="floatEl" class="ai-float">
          <Composer :disabled="stage === 'busy'" @text="sendText" @voice="sendVoice" @error="(c) => (micError = c)" />
        </div>
      </template>

      <!-- 3) Tekshirish va tasdiqlash -->
      <template v-else-if="stage === 'draft' && draft">
        <div class="ai-scroll">
          <div class="ai-kind">
            <component :is="KIND_ICON[draft.kind]" class="h-5 w-5" />
            <span>{{ $t(`cloud.ai.kind.${draft.kind}`) }}</span>
          </div>
          <div class="ai-quote">
            <button v-if="lastVoice" type="button" class="ai-quote-play" :aria-label="playing?.n === lastVoice.n && !playing.paused ? $t('cloud.ai.pause') : $t('cloud.ai.play')" @click="togglePlay(lastVoice.n, lastVoice.sent)">
              <Pause v-if="playing?.n === lastVoice.n && !playing.paused" class="h-3.5 w-3.5" />
              <Play v-else class="h-3.5 w-3.5 translate-x-px" />
            </button>
            <span>«{{ draft.transcript }}»</span>
          </div>

          <div v-if="spoken" class="ai-rate">
            <div class="text-sm font-semibold">{{ $t('cloud.ai.rateTitle', { cur: dispCur }) }}</div>
            <div v-if="draft.fx" class="text-xs text-muted-foreground">{{ draft.fx.source === 'saved' ? $t('cloud.ai.fxSaved') : $t('cloud.ai.fxCbu', { date: draft.fx.date ?? '' }) }}</div>
            <div class="mt-2 flex items-center gap-2">
              <span class="shrink-0 text-sm">1 {{ dispCur }} =</span>
              <MoneyInput v-model="rate" class="ai-num flex-1" :currency="currencySymbol" />
              <button type="button" class="ai-convert" :disabled="!(Number(rate) > 0) || converting" @click="convert">{{ $t('cloud.ai.convert', { shop: currencySymbol }) }}</button>
            </div>
          </div>

          <div v-if="draft.issues.length" class="ai-issues">
            <div v-for="(i, n) in draft.issues" :key="n">⚠️ {{ issueText(i) }}</div>
            <div v-if="draft.kind === 'unknown'">{{ draft.question ?? $t('cloud.ai.unknownHint') }}</div>
          </div>

          <template v-if="draft.kind !== 'unknown' && draft.allowed">
            <!-- Mijoz -->
            <section v-if="draft.kind === 'sale' || draft.kind === 'payment_in'" class="ai-field">
              <label>{{ $t('cloud.ai.customer') }}</label>
              <div v-if="draft.newCustomer && !draft.customerId" class="ai-newcust">
                <span>🆕 <b>{{ draft.newCustomer }}</b> — {{ $t('cloud.ai.newCustomerTag') }}</span>
              </div>
              <div v-else-if="!draft.customerId && draft.customerOptions.length" class="ai-pick">
                <span class="text-xs text-muted-foreground">{{ $t('cloud.ai.didYouMean') }}</span>
                <button v-for="c in draft.customerOptions" :key="c.id" type="button" class="ai-chip" @click="pickCustomer(c.id)">{{ c.name }}</button>
              </div>
              <button v-if="isOwner() && draft.customerQuery && !draft.customerId && !draft.newCustomer" type="button" class="ai-chip self-start" @click="useNewCustomer">
                + {{ $t('cloud.ai.addAsNewCustomer', { name: draft.customerQuery }) }}
              </button>
              <SearchableSelect :model-value="draft.customerId" :items="customerItems" :placeholder="draft.newCustomer ? $t('cloud.ai.orChooseExisting') : $t('cloud.ai.chooseCustomer')" @update:model-value="pickCustomer" />
            </section>

            <!-- Tovarlar -->
            <section v-if="draft.kind === 'sale' || draft.kind === 'receipt'" class="ai-items">
              <div v-for="(it, n) in draft.items" :key="n" class="ai-item" :class="{ unresolved: !it.productId }">
                <template v-if="it.productId">
                  <div class="flex items-start gap-2">
                    <div class="min-w-0 flex-1">
                      <div class="truncate font-semibold">{{ it.name }}</div>
                      <div v-if="it.stock !== null" class="text-xs text-muted-foreground">{{ $t('cloud.ai.stock', { n: qty(it.stock) }) }} {{ it.unit }}</div>
                    </div>
                    <!-- Qator jami nom yonida: pastki qatorda narx maydoniga butun kenglik qoladi (tor ekranda raqam kesilmasin). -->
                    <span class="shrink-0 pt-0.5 text-sm font-semibold tabular-nums">{{ showMoney(Math.round(it.qty * (it.price ?? 0) * 100) / 100) }}</span>
                    <button type="button" class="ai-x" @click="removeItem(n)"><X class="h-4 w-4" /></button>
                  </div>
                  <div class="mt-2 flex items-center gap-2">
                    <div class="ai-stepper shrink-0">
                      <button type="button" @click="step(it, -1)"><Minus class="h-4 w-4" /></button>
                      <input v-model.number="it.qty" type="number" inputmode="decimal" min="0" @change="changed" />
                      <button type="button" @click="step(it, 1)"><Plus class="h-4 w-4" /></button>
                    </div>
                    <span class="shrink-0 text-muted-foreground">×</span>
                    <MoneyInput v-if="priceEditable" v-model="it.price" :currency="dispCur" class="ai-num min-w-0 flex-1"
                      :placeholder="draft.kind === 'receipt' ? $t('cloud.ai.cost') : $t('cloud.ai.price')" @change="changed" />
                    <span v-else class="tabular-nums">{{ showMoney(it.price ?? 0) }}</span>
                  </div>
                </template>
                <template v-else>
                  <div class="flex items-start gap-2">
                    <div class="min-w-0 flex-1 text-sm">❓ «{{ it.query }}» — <span class="text-muted-foreground">{{ $t('cloud.ai.didYouMean') }}</span></div>
                    <button type="button" class="ai-x" @click="removeItem(n)"><X class="h-4 w-4" /></button>
                  </div>
                  <div class="ai-pick">
                    <button v-for="o in it.options" :key="o.id" type="button" class="ai-chip" @click="pickProduct(it, o.id)">
                      {{ o.name }} <span class="opacity-60">· {{ moneySum(o.price) }}</span>
                    </button>
                  </div>
                  <SearchableSelect :model-value="null" :items="productItems" :placeholder="$t('cloud.ai.otherProduct')" @update:model-value="(v) => pickProduct(it, v)" />
                </template>
              </div>
              <SearchableSelect :model-value="null" :items="productItems" :placeholder="'+ ' + $t('cloud.ai.addProduct')" @update:model-value="addProduct" />
            </section>

            <!-- Yangi mijozlar -->
            <section v-if="draft.kind === 'customer'" class="ai-items">
              <div v-for="(p, n) in draft.people" :key="n" class="ai-item">
                <div class="flex items-center gap-2">
                  <input v-model="p.name" class="ai-text flex-1 font-semibold" :placeholder="$t('cloud.ai.personName')" @change="changed" />
                  <button type="button" class="ai-x" @click="removePerson(n)"><X class="h-4 w-4" /></button>
                </div>
                <input v-model="p.phone" class="ai-text mt-2" type="tel" inputmode="tel" :placeholder="$t('cloud.ai.phone')" @change="changed" />
                <div class="ai-seg mt-2">
                  <button v-for="k in (['none', 'debt', 'credit'] as const)" :key="k" type="button" :class="{ on: p.kind === k }" @click="p.kind = k; haptic('select'); changed()">{{ $t(`cloud.ai.bal.${k}`) }}</button>
                </div>
                <MoneyInput v-if="p.kind !== 'none'" v-model="p.amount" :currency="dispCur" class="ai-num full mt-2" @change="changed" />
              </div>
              <button type="button" class="ai-chip self-start" @click="addPerson(); changed()">+ {{ $t('cloud.ai.addPerson') }}</button>
            </section>

            <!-- Yangi tovarlar -->
            <section v-if="draft.kind === 'product'" class="ai-items">
              <div v-for="(it, n) in draft.items" :key="n" class="ai-item">
                <div class="flex items-center gap-2">
                  <input v-model="it.name" class="ai-text flex-1 font-semibold" :placeholder="$t('cloud.ai.productName')" @change="changed" />
                  <button type="button" class="ai-x" @click="removeItem(n)"><X class="h-4 w-4" /></button>
                </div>
                <div class="mt-2 grid grid-cols-2 gap-2">
                  <label class="ai-mini"><span>{{ $t('cloud.ai.salePrice') }}</span><MoneyInput v-model="it.price" :currency="dispCur" class="ai-num full" @change="changed" /></label>
                  <label class="ai-mini"><span>{{ $t('cloud.ai.costPrice') }}</span><MoneyInput v-model="it.cost" :currency="dispCur" class="ai-num full" @change="changed" /></label>
                  <label class="ai-mini"><span>{{ $t('cloud.ai.startStock') }}</span><input v-model.number="it.qty" class="ai-num full" type="number" inputmode="decimal" min="0" @change="changed" /></label>
                  <label class="ai-mini"><span>{{ $t('cloud.ai.unit') }}</span><input v-model="it.unit" class="ai-text" @change="changed" /></label>
                </div>
              </div>
              <button type="button" class="ai-chip self-start" @click="addRow(); changed()">+ {{ $t('cloud.ai.addRow') }}</button>
            </section>

            <!-- To'lov usuli -->
            <section v-if="draft.kind === 'sale' || draft.kind === 'payment_in'" class="ai-field">
              <div class="ai-seg">
                <button v-for="m in methods" :key="m" type="button" :class="{ on: draft.method === m }" @click="draft.method = m; haptic('select'); changed()">{{ $t(`cloud.ai.method.${m}`) }}</button>
              </div>
              <div v-if="draft.kind === 'sale' && draft.method === 'debt'" class="mt-2 flex items-center gap-2">
                <label class="shrink-0 text-sm text-muted-foreground">{{ $t('cloud.ai.paidNow') }}</label>
                <MoneyInput v-model="draft.paid" :currency="dispCur" class="ai-num flex-1" placeholder="0" @change="changed" />
              </div>
            </section>

            <!-- Summa / toifa / izoh -->
            <section v-if="draft.kind === 'payment_in' || draft.kind === 'expense'" class="ai-field">
              <label>{{ $t('cloud.ai.amount') }}</label>
              <MoneyInput v-model="draft.amount" :currency="dispCur" class="ai-num ai-big" @change="changed" />
            </section>
            <section v-if="draft.kind === 'expense'" class="ai-field">
              <label>{{ $t('cloud.ai.category') }}</label>
              <div class="ai-pick">
                <button v-for="c in CATEGORIES" :key="c" type="button" class="ai-chip" :class="{ on: draft.category === c }" @click="draft.category = c; changed()">{{ c }}</button>
              </div>
            </section>
            <section v-if="draft.kind === 'receipt'" class="ai-field">
              <label>{{ $t('cloud.ai.supplier') }}</label>
              <input v-model="draft.supplier" class="ai-text" @change="changed" />
            </section>
            <section v-if="draft.kind !== 'sale' && draft.kind !== 'product'" class="ai-field">
              <label>{{ $t('cloud.ai.note') }}</label>
              <input v-model="draft.note" class="ai-text" @change="changed" />
            </section>
          </template>
        </div>

        <div class="ai-foot">
          <div v-if="draft.kind !== 'unknown' && draft.kind !== 'customer' && draft.allowed" class="ai-total">
            <span>{{ $t('cloud.ai.total') }}</span>
            <span class="tabular-nums">{{ showMoney(draft.total) }}</span>
          </div>
          <div class="grid grid-cols-[1fr_auto] gap-2">
            <button type="button" class="h-12 rounded-xl bg-primary text-base font-semibold text-primary-foreground" :disabled="!canConfirm" @click="confirmDraft">
              {{ $t('cloud.ai.confirm') }}
            </button>
            <button type="button" class="h-12 rounded-xl border px-5 text-sm font-medium" @click="cancelDraft">{{ $t('cloud.ai.cancel') }}</button>
          </div>
        </div>
      </template>

      <!-- 4) Saqlandi -->
      <div v-else-if="stage === 'done' && draft" class="ai-done">
        <CheckCircle2 class="h-14 w-14 text-emerald-500" />
        <div class="text-lg font-bold">{{ $t('cloud.ai.saved') }}</div>
        <div class="text-sm text-muted-foreground">{{ $t(`cloud.ai.kind.${draft.kind}`) }} · {{ resultText }}</div>
        <div class="mt-4 grid w-full grid-cols-2 gap-2">
          <button type="button" class="h-12 rounded-xl bg-primary text-sm font-semibold text-primary-foreground" @click="back">{{ $t('cloud.ai.again') }}</button>
          <button type="button" class="h-12 rounded-xl border text-sm font-medium" @click="close">{{ $t('cloud.ai.close') }}</button>
        </div>
      </div>
    </div>
  </div>
  </Transition>
  </Teleport>
</template>

<style scoped>
.ai-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  padding: 0 1rem;
}
.ai-examples,
.ai-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.ai-pick {
  align-items: center;
  margin-bottom: 0.5rem;
}
.ai-chip {
  max-width: 100%;
  padding: 0.5rem 0.875rem;
  border-radius: 9999px;
  background: var(--accent);
  box-shadow: inset 0 1px 0 var(--glass-edge, transparent), inset 0 0 0 0.5px var(--glass-rim, transparent);
  font-size: 0.875rem;
  text-align: left;
}
.ai-chip.on {
  background: var(--glass-tint, var(--primary));
  color: var(--on-tint, #fff);
}
/* Pastga tekislash justify-content: flex-end bilan EMAS — u holda tepadan oshgan xabarlarga aylantirib
   bo'lmaydi. Birinchi xabar margin-top: auto bilan pastga itariladi, ko'payganda oddiy scroll. */
.ai-chat {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0.25rem 0;
}
.ai-chat > :first-child {
  margin-top: auto;
}
.ai-msg {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  animation: ai-pop 0.28s cubic-bezier(0.34, 1.4, 0.64, 1) both;
}
.ai-msg.out {
  justify-content: flex-end;
  transform-origin: bottom right;
}
.ai-msg.in {
  transform-origin: bottom left;
}
@keyframes ai-pop {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.92);
  }
}
.ai-avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 1.9rem;
  height: 1.9rem;
  border-radius: 9999px;
  background-color: var(--glass-tint, var(--primary));
  color: var(--on-tint, #fff);
}
.ai-bubble {
  position: relative;
  max-width: 82%;
  padding: 0.55rem 0.8rem;
  border-radius: 1.1rem 1.1rem 1.1rem 0.35rem;
  background: var(--card);
  box-shadow: inset 0 1px 0 var(--glass-edge, transparent), inset 0 0 0 0.5px var(--glass-rim, var(--border)), 0 1px 2px rgb(0 0 0 / 0.06);
  font-size: 0.9375rem;
  line-height: 1.35;
}
.ai-bubble.out {
  padding-right: 2.6rem;
  border-radius: 1.1rem 1.1rem 0.35rem 1.1rem;
  background-color: var(--glass-tint, var(--primary));
  background-image: linear-gradient(180deg, rgb(255 255 255 / 0.14), transparent 60%);
  color: var(--on-tint, #fff);
}
.ai-link {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.5rem;
  color: var(--foreground);
  font-size: 0.8125rem;
  font-weight: 600;
  text-decoration: underline;
}
.ai-bubble.warn {
  background: color-mix(in oklab, var(--color-amber-500) 16%, var(--card));
}
.ai-tick {
  position: absolute;
  right: 0.6rem;
  bottom: 0.35rem;
  font-size: 0.7rem;
  letter-spacing: -2px;
  opacity: 0.55;
}
.ai-tick.read {
  opacity: 0.95;
}
.ai-voice {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.ai-voice-ico {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 9999px;
  background: rgb(255 255 255 / 0.2);
}
.ai-wave {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 24px;
}
.ai-wave i {
  display: block;
  width: 3px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.9;
  transition: opacity 0.12s;
}
/* Tinglanayotganda hali eshitilmagan qism xira (Telegram kabi). */
.ai-wave i.dim {
  opacity: 0.4;
}
button.ai-voice-ico {
  flex: none;
  color: inherit;
  transition: transform 0.12s;
}
button.ai-voice-ico:active {
  transform: scale(0.92);
}
.ai-dur {
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}
.ai-bubble.typing {
  padding: 0.8rem 0.9rem;
}
.ai-examples {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  padding: 0.5rem 0 0;
  animation: ai-pop 0.3s 0.08s cubic-bezier(0.34, 1.4, 0.64, 1) both;
}
.ai-examples-title {
  width: 100%;
  margin-bottom: 0.125rem;
  color: var(--muted-foreground);
  font-size: 0.75rem;
  font-weight: 500;
}
/* Bosiladigan namuna: shaffof, ingichka chegara, kichik shrift — pufakchadan aniq farq qiladi. */
.ai-example {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  max-width: 100%;
  height: 2rem;
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: 9999px;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  transition: background-color 0.15s, color 0.15s, transform 0.15s;
}
.ai-example:active {
  background: var(--accent);
  color: var(--foreground);
  transform: scale(0.97);
}
.ai-busy,
.ai-done {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding-bottom: 2rem;
  text-align: center;
}
.ai-dots {
  display: flex;
  gap: 6px;
}
.ai-dots span {
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  background: var(--foreground);
  animation: ai-dot 1s ease-in-out infinite;
}
.ai-dots span:nth-child(2) { animation-delay: 0.15s; }
.ai-dots span:nth-child(3) { animation-delay: 0.3s; }
@keyframes ai-dot {
  0%, 100% { opacity: 0.25; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-4px); }
}
.ai-quote {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  font-style: italic;
}
.ai-quote-play {
  display: grid;
  flex: none;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  margin-top: -0.2rem;
  border-radius: 9999px;
  background-color: var(--glass-tint, var(--primary));
  color: var(--on-tint, #fff);
  font-style: normal;
}
.ai-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-bottom: 0.75rem;
}
.ai-kind {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.0625rem;
  font-weight: 700;
}
.ai-rate {
  padding: 0.75rem;
  border-radius: 0.875rem;
  background: color-mix(in oklab, var(--color-sky-500) 12%, var(--accent));
}
.ai-convert {
  flex: none;
  height: 2.5rem;
  padding: 0 0.9rem;
  border-radius: 9999px;
  background-color: var(--glass-tint, var(--primary));
  color: var(--on-tint, #fff);
  font-size: 0.8125rem;
  font-weight: 600;
}
.ai-convert:disabled {
  opacity: 0.4;
}
.ai-newcust {
  padding: 0.625rem 0.75rem;
  border-radius: 0.875rem;
  background: color-mix(in oklab, var(--color-emerald-500) 12%, var(--accent));
  font-size: 0.875rem;
}
.ai-issues {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.625rem 0.75rem;
  border-radius: 0.875rem;
  background: color-mix(in oklab, var(--color-amber-500) 14%, transparent);
  color: color-mix(in oklab, var(--color-amber-700) 90%, var(--foreground));
  font-size: 0.8125rem;
}
.ai-field label {
  display: block;
  margin-bottom: 0.375rem;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  font-weight: 500;
}
.ai-items {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.ai-item {
  padding: 0.75rem;
  border-radius: 1rem;
  background: var(--accent);
  box-shadow: inset 0 1px 0 var(--glass-edge, transparent), inset 0 0 0 0.5px var(--glass-rim, transparent);
}
.ai-item.unresolved {
  background: color-mix(in oklab, var(--color-amber-500) 10%, var(--accent));
}
.ai-x {
  display: grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 9999px;
  color: var(--muted-foreground);
}
/* Miqdor stepperi — kassa savatidagi bilan bir xil: yumshoq kapsula, tekis −/+ tugma rangida, qalin raqam. */
.ai-stepper {
  display: flex;
  align-items: center;
  height: 2.5rem;
  padding: 0 0.1875rem;
  border-radius: 9999px;
  background: var(--secondary);
  box-shadow: inset 0 0 0 0.5px var(--glass-rim, transparent);
}
.ai-stepper button {
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 9999px;
  background: transparent !important;
  box-shadow: none !important;
  color: var(--primary);
  transition: background-color 0.15s, transform 0.12s;
}
.ai-stepper button:active {
  background: var(--accent) !important;
  transform: scale(0.88);
}
.ai-stepper input {
  width: 2.5rem;
  border: 0;
  outline: none;
  background: transparent;
  font-size: 16px;
  font-weight: 700;
  text-align: center;
}
.ai-num,
.ai-text {
  min-width: 0;
  height: 2.5rem;
  padding: 0 0.875rem;
  border-radius: 9999px;
  outline: none;
  background: var(--background);
  font-size: 16px;
}
.ai-num.full {
  width: 100%;
}
/* MoneyInput ichidagi input — boshqa komponent (scoped uslub yetmaydi). */
.ai-body :deep(input.ai-num) {
  min-width: 0;
  height: 2.5rem;
  padding-left: 0.875rem;
  border-radius: 9999px;
  outline: none;
  background: var(--background);
  font-size: 16px;
}
.ai-body :deep(input.ai-big) {
  height: 3rem;
  font-size: 1.25rem;
  font-weight: 700;
}
.ai-body :deep(.money-wrap:not(.flex-1)) {
  width: 7.5rem;
}
.ai-body :deep(.money-wrap:has(input.full)),
.ai-body :deep(.money-wrap:has(input.ai-big)) {
  width: 100%;
}
.ai-mini {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  color: var(--muted-foreground);
  font-size: 0.75rem;
  font-weight: 500;
}
.ai-num {
  width: 7.5rem;
  font-variant-numeric: tabular-nums;
}
.ai-text,
.ai-big {
  width: 100%;
}
.ai-big {
  height: 3rem;
  font-size: 1.25rem;
  font-weight: 700;
}
.ai-seg {
  display: grid;
  grid-auto-columns: 1fr;
  grid-auto-flow: column;
  gap: 4px;
  padding: 4px;
  border-radius: 9999px;
  background: var(--accent);
}
.ai-seg button {
  height: 2.5rem;
  border-radius: 9999px;
  font-size: 0.875rem;
  font-weight: 600;
  opacity: 0.6;
}
.ai-seg button.on {
  background: var(--lens-fill, var(--card));
  box-shadow: inset 0 1px 0 var(--glass-edge, transparent), 0 4px 12px -4px rgb(0 0 0 / 0.2);
  opacity: 1;
}
.ai-foot {
  flex: none;
  padding: 0.75rem 0 0.25rem;
  border-top: 0.5px solid var(--border);
}
.ai-total {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.625rem;
  font-size: 1.125rem;
  font-weight: 700;
}
/* ======================= To'liq ekran (Telegram chat oynasi) ======================= */
.ai-screen {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  height: var(--app-h, 100dvh);
  background: var(--background);
}
.ai-screen-enter-active,
.ai-screen-leave-active {
  transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.2s;
}
.ai-screen-enter-from,
.ai-screen-leave-to {
  transform: translateX(100%);
  opacity: 0.6;
}
.ai-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.625rem;
  padding: calc(var(--chrome-top) + 0.5rem) 0.5rem 0.5rem;
  background: color-mix(in srgb, var(--card) 88%, transparent);
  box-shadow: 0 1px 0 var(--border);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
}
.ai-head-btn {
  display: grid;
  flex: none;
  place-items: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 9999px;
  background: transparent !important;
  box-shadow: none !important;
  color: var(--foreground);
}
.ai-head-btn:active {
  background: var(--accent) !important;
}
.ai-head-avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 9999px;
  background: #0b0b0d;
  color: #fff;
  font-size: 1.125rem;
  font-weight: 800;
  font-style: italic;
}
.ai-head-name {
  overflow: hidden;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-head-sub {
  color: var(--muted-foreground);
  font-size: 0.8125rem;
}
.ai-head-sub.busy {
  color: var(--primary);
}
.ai-screen .ai-body {
  flex: 1;
  padding: 0 0.5rem calc(var(--safe-bottom) + 0.25rem);
}
/* Suzuvchi yozish paneli (Telegram): chat ekran tagigacha aylanadi, maydon va mikrofon uning USTIDA turadi —
   orqasida panel foni yo'q, xabarlar ostidan o'tib ketadi. */
.ai-screen .ai-body.floating {
  padding-bottom: 0;
}
.ai-body.floating .tg-chat {
  padding-bottom: calc(var(--float-h, 64px) + var(--safe-bottom) + 0.625rem);
}
.ai-chat.loading {
  visibility: hidden;
}
.ai-float {
  position: absolute;
  right: 0.5rem;
  bottom: calc(var(--safe-bottom) + 0.375rem);
  left: 0.5rem;
  z-index: 2;
  pointer-events: none;
}
.ai-float > :deep(*) {
  pointer-events: auto;
}
.ai-float :deep(.tc) {
  padding: 0;
}
.ai-float :deep(.tc-field),
.ai-float :deep(.tc-rec) {
  background: color-mix(in srgb, var(--card) 90%, transparent);
  box-shadow: inset 0 0 0 0.5px var(--glass-rim, var(--border)), 0 2px 12px -3px rgb(0 0 0 / 0.28);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  backdrop-filter: blur(14px) saturate(1.4);
}
.ai-float :deep(.tc-action) {
  box-shadow: 0 3px 12px -3px rgb(0 0 0 / 0.4);
}
/* Chatlar ro'yxati */
.ai-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem 0;
}
.ai-list-new {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  width: 100%;
  padding: 0.75rem;
  border-radius: 0.875rem;
  background: transparent;
  color: var(--primary);
  font-weight: 600;
}
.ai-list-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.625rem 0.75rem;
  border-radius: 0.875rem;
  background: transparent;
}
.ai-list-row:active {
  background: var(--accent);
}
.ai-list-ava {
  display: grid;
  flex: none;
  place-items: center;
  width: 3rem;
  height: 3rem;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--primary) 22%, var(--card));
  color: var(--primary);
  font-size: 1.125rem;
  font-weight: 700;
}
/* Karta (botdagidek) va ovoz transkripti */
.tg-card :deep(b) {
  font-weight: 700;
}
.tg-card.saved,
.tg-card.cancelled,
.tg-card.replaced,
.tg-card.expired {
  opacity: 0.9;
}
.tg-transcript {
  margin-top: 0.25rem;
  font-size: 0.875rem;
  opacity: 0.85;
}
.tg-kb-row {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 0.25rem;
}
.tg-kb.busy {
  opacity: 0.5;
  pointer-events: none;
}

/* ======================= Telegram suhbati ======================= */
.ai-body {
  position: relative;
  isolation: isolate;
}
/* Oboy naqshi: mavzu matn rangida juda xira (Telegram oboylari kabi), qatlam kontent ortida. */
.ai-body::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background-color: var(--foreground);
  opacity: 0.055;
  -webkit-mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22220%22%20height%3D%22200%22%20viewBox%3D%220%200%20220%20200%22%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20transform%3D%22translate%2814%2016%29%22%20d%3D%22M2%203h3l2.2%2010.5h9.6L19%206H6.2M9%2018.5a1.2%201.2%200%201%200%200%20.1M15.5%2018.5a1.2%201.2%200%201%200%200%20.1%22/%3E%3Cpath%20transform%3D%22translate%2878%2010%29%22%20d%3D%22M11%202a9%209%200%201%200%200%2018a9%209%200%201%200%200-18M13.5%207.5c-.7-.8-1.7-1.2-2.8-1.2c-1.7%200-2.7.9-2.7%202s1%201.7%202.7%202s3%20.9%203%202.2s-1.3%202.2-3%202.2c-1.2%200-2.3-.5-3-1.3M11%204.8v12.4%22/%3E%3Cpath%20transform%3D%22translate%28148%2020%29%22%20d%3D%22M4%202h14v20l-2.5-1.6L13%2022l-2-1.6L9%2022l-2.5-1.6L4%2022zM7.5%207h7M7.5%2011h7M7.5%2015h4%22/%3E%3Cpath%20transform%3D%22translate%2840%2074%29%22%20d%3D%22M12%202l9%205v10l-9%205l-9-5V7zM3%207l9%205l9-5M12%2012v10%22/%3E%3Cpath%20transform%3D%22translate%28112%2070%29%22%20d%3D%22M3%203h8l10%2010l-8%208L3%2011zM7.5%207.5h.1%22/%3E%3Cpath%20transform%3D%22translate%28176%2082%29%22%20d%3D%22M3%2021h18M6%2017v-5M11%2017V8M16%2017v-8M20%2017V5%22/%3E%3Cpath%20transform%3D%22translate%2812%20140%29%22%20d%3D%22M12%203l1.8%205.2L19%2010l-5.2%201.8L12%2017l-1.8-5.2L5%2010l5.2-1.8z%22/%3E%3Cpath%20transform%3D%22translate%2876%20132%29%22%20d%3D%22M4%206h16v12H4zM4%2010h16M8%2014h3%22/%3E%3Cpath%20transform%3D%22translate%28140%20142%29%22%20d%3D%22M6%203h9l4%204v14H6zM15%203v4h4M9%2012h7M9%2016h5%22/%3E%3Cpath%20transform%3D%22translate%28186%20150%29%22%20d%3D%22M5%2012h14M12%205v14%22/%3E%3C/g%3E%3C/svg%3E") 0 0 / 220px 200px repeat;
  mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22220%22%20height%3D%22200%22%20viewBox%3D%220%200%20220%20200%22%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20transform%3D%22translate%2814%2016%29%22%20d%3D%22M2%203h3l2.2%2010.5h9.6L19%206H6.2M9%2018.5a1.2%201.2%200%201%200%200%20.1M15.5%2018.5a1.2%201.2%200%201%200%200%20.1%22/%3E%3Cpath%20transform%3D%22translate%2878%2010%29%22%20d%3D%22M11%202a9%209%200%201%200%200%2018a9%209%200%201%200%200-18M13.5%207.5c-.7-.8-1.7-1.2-2.8-1.2c-1.7%200-2.7.9-2.7%202s1%201.7%202.7%202s3%20.9%203%202.2s-1.3%202.2-3%202.2c-1.2%200-2.3-.5-3-1.3M11%204.8v12.4%22/%3E%3Cpath%20transform%3D%22translate%28148%2020%29%22%20d%3D%22M4%202h14v20l-2.5-1.6L13%2022l-2-1.6L9%2022l-2.5-1.6L4%2022zM7.5%207h7M7.5%2011h7M7.5%2015h4%22/%3E%3Cpath%20transform%3D%22translate%2840%2074%29%22%20d%3D%22M12%202l9%205v10l-9%205l-9-5V7zM3%207l9%205l9-5M12%2012v10%22/%3E%3Cpath%20transform%3D%22translate%28112%2070%29%22%20d%3D%22M3%203h8l10%2010l-8%208L3%2011zM7.5%207.5h.1%22/%3E%3Cpath%20transform%3D%22translate%28176%2082%29%22%20d%3D%22M3%2021h18M6%2017v-5M11%2017V8M16%2017v-8M20%2017V5%22/%3E%3Cpath%20transform%3D%22translate%2812%20140%29%22%20d%3D%22M12%203l1.8%205.2L19%2010l-5.2%201.8L12%2017l-1.8-5.2L5%2010l5.2-1.8z%22/%3E%3Cpath%20transform%3D%22translate%2876%20132%29%22%20d%3D%22M4%206h16v12H4zM4%2010h16M8%2014h3%22/%3E%3Cpath%20transform%3D%22translate%28140%20142%29%22%20d%3D%22M6%203h9l4%204v14H6zM15%203v4h4M9%2012h7M9%2016h5%22/%3E%3Cpath%20transform%3D%22translate%28186%20150%29%22%20d%3D%22M5%2012h14M12%205v14%22/%3E%3C/g%3E%3C/svg%3E") 0 0 / 220px 200px repeat;
  pointer-events: none;
}
.tg-chat {
  gap: 0.125rem;
  padding: 0.25rem 0 0.5rem;
  overflow-x: hidden;
}
.tg-date {
  display: flex;
  justify-content: center;
  margin: 0.25rem 0 0.5rem;
}
.tg-date span {
  padding: 0.2rem 0.625rem;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--foreground) 14%, transparent);
  color: var(--foreground);
  font-size: 0.8125rem;
  font-weight: 500;
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
}
.tg-row {
  display: flex;
  padding: 0 0.625rem;
}
.tg-row.out {
  justify-content: flex-end;
}
/* Telegram animatsiyalari: yuborilgan xabar maydondan o'ng pastdan "uchib" chiqadi, javob chap pastdan
   prujina bilan kattalashadi. Faqat yangilari (tarix ochilganda emas). */
.tg-row.anim.out > .tg-bubble {
  transform-origin: 100% 100%;
  animation: tg-send 0.34s cubic-bezier(0.2, 0.9, 0.25, 1.12) both;
}
.tg-row.anim.in > .tg-bubble {
  transform-origin: 0 100%;
  animation: tg-recv 0.32s cubic-bezier(0.2, 0.9, 0.25, 1.15) both;
}
.tg-kb.anim {
  animation: tg-kb 0.3s 0.12s cubic-bezier(0.2, 0.9, 0.25, 1) both;
}
@keyframes tg-send {
  0% { opacity: 0; transform: translate(14px, 30px) scale(0.84); }
  55% { opacity: 1; }
  100% { opacity: 1; transform: none; }
}
@keyframes tg-recv {
  0% { opacity: 0; transform: translate(-6px, 12px) scale(0.88); }
  100% { opacity: 1; transform: none; }
}
@keyframes tg-kb {
  0% { opacity: 0; transform: translateY(8px); }
  100% { opacity: 1; transform: none; }
}
/* "Yozmoqda": uchta nuqta navbat bilan sakraydi (Telegram kabi). */
.tg-typing {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.75rem 0.875rem;
}
.tg-typing i,
.tg-hdots i {
  display: block;
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 9999px;
  background: currentColor;
  opacity: 0.45;
  animation: tg-dot 1.2s infinite ease-in-out;
}
.tg-typing i:nth-child(2),
.tg-hdots i:nth-child(2) {
  animation-delay: 0.15s;
}
.tg-typing i:nth-child(3),
.tg-hdots i:nth-child(3) {
  animation-delay: 0.3s;
}
.tg-hdots {
  display: inline-flex;
  gap: 0.15rem;
  margin-left: 0.2rem;
  vertical-align: middle;
}
.tg-hdots i {
  width: 0.25rem;
  height: 0.25rem;
}
@keyframes tg-dot {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-0.25rem); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .tg-row.anim > .tg-bubble, .tg-kb.anim, .tg-typing i, .tg-hdots i { animation: none; }
}
.tg-row:has(.tail) {
  margin-bottom: 0.375rem;
}
@keyframes tg-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.96);
  }
}
/* Ranglar: kiruvchi — bo'lim rangi; chiquvchi — Telegram'dagidek (yorug'da och yashil, qorong'ida tugma rangidan). */
.tg-chat {
  --tg-in: var(--card);
  --tg-out: #effdde;
  --tg-out-text: #000;
  --tg-out-meta: #5fa85a;
  --tg-in-meta: color-mix(in srgb, var(--foreground) 45%, transparent);
}
:global(.dark .tg-chat) {
  --tg-out: color-mix(in srgb, var(--primary) 48%, var(--card));
  --tg-out-text: #fff;
  --tg-out-meta: color-mix(in srgb, #fff 62%, transparent);
}
.tg-bubble {
  position: relative;
  max-width: 82%;
  padding: 0.375rem 0.5625rem 0.375rem 0.6875rem;
  border-radius: 1.0625rem;
  background: var(--tg-in);
  color: var(--foreground);
  font-size: 1rem;
  line-height: 1.3125;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  box-shadow: 0 1px 1px rgb(0 0 0 / 0.12);
}
.tg-bubble.out {
  background: var(--tg-out);
  color: var(--tg-out-text);
}
.tg-bubble.in.tail {
  border-bottom-left-radius: 0.3rem;
}
.tg-bubble.out.tail {
  border-bottom-right-radius: 0.3rem;
}
/* "Dum" — Telegram pufagining pastki burchagidagi egri uchi (pufak rangini oladi). */
.tg-bubble.tail::after {
  content: '';
  position: absolute;
  bottom: 0;
  width: 9px;
  height: 17px;
  background: inherit;
  -webkit-mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%229%22%20height%3D%2217%22%20viewBox%3D%220%200%209%2017%22%3E%3Cpath%20d%3D%22M9%200v17H1.5C.6%2017%200%2016.4%200%2015.9c0-.4.2-.7.6-.9C5%2012.5%208.5%208%209%200z%22/%3E%3C/svg%3E") no-repeat;
  mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%229%22%20height%3D%2217%22%20viewBox%3D%220%200%209%2017%22%3E%3Cpath%20d%3D%22M9%200v17H1.5C.6%2017%200%2016.4%200%2015.9c0-.4.2-.7.6-.9C5%2012.5%208.5%208%209%200z%22/%3E%3C/svg%3E") no-repeat;
}
.tg-bubble.in.tail::after {
  left: -8px;
}
.tg-bubble.out.tail::after {
  right: -8px;
  transform: scaleX(-1);
}
.tg-bubble.warn {
  background: color-mix(in oklab, var(--color-amber-500) 22%, var(--tg-in));
}
/* Vaqt (va ✓✓) oxirgi qatorning o'ng pastida — matn ostiga tushmasligi uchun joy (spacer) qoldiriladi. */
.tg-spacer {
  display: inline-block;
  width: 2.6rem;
  height: 0.5rem;
}
.tg-spacer.wide {
  width: 3.7rem;
}
.tg-bubble.voice .tg-spacer {
  display: block;
  height: 0.6rem;
}
.tg-meta {
  position: absolute;
  right: 0.55rem;
  bottom: 0.3rem;
  color: var(--tg-in-meta);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
}
.tg-bubble.out .tg-meta {
  color: var(--tg-out-meta);
}
.tg-ticks {
  margin-left: 0.1rem;
  letter-spacing: -0.28em;
}
.tg-bubble.out .ai-voice-ico {
  width: 2.75rem;
  height: 2.75rem;
  background: var(--tg-out-text);
  color: var(--tg-out);
}
.tg-bubble.out .ai-voice-ico :deep(svg) {
  width: 1.25rem;
  height: 1.25rem;
  fill: currentColor;
}
.tg-bubble.out .ai-wave i {
  width: 2px;
}
.tg-bubble.out .ai-dur {
  color: var(--tg-out-meta);
  opacity: 1;
}
/* Xabar ostidagi inline tugmalar (Telegram bot klaviaturasi): pufak kengligida, shaffof, oq matn. */
.tg-kb {
  display: grid;
  gap: 0.25rem;
  width: min(85%, 22rem);
  margin: 0.125rem 0 0.5rem 0.625rem;
  animation: tg-in 0.24s 0.05s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.tg-kb-btn {
  min-height: 2.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.875rem;
  background: color-mix(in srgb, var(--foreground) 16%, transparent);
  color: var(--foreground);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.25;
  text-align: center;
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  transition: background-color 0.15s, transform 0.12s;
}
.tg-kb-btn:active {
  background: color-mix(in srgb, var(--foreground) 26%, transparent);
  transform: scale(0.98);
}
</style>
