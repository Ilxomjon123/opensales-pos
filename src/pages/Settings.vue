<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import SearchableSelect from '../components/SearchableSelect.vue'
import { Check, Store, Coins, ShoppingCart, ShieldCheck, KeyRound, Copy, FileText, DatabaseBackup, RotateCcw, RefreshCw, Download, CloudUpload, Lock, LockOpen, Printer } from 'lucide-vue-next'
import { getSetting, setSetting } from '../lib/db'
import { listPrinters } from '../lib/silentprint'
import { setCurrency, formatDateTime } from '../lib/format'
import { license, refreshLicense, activate, isOwnerMaster } from '../lib/license'
import { listBackups, makeBackup, restoreBackup, backupPin, githubDownload, syncNow as libSyncNow, lastSync, loadLastSync, syncing, githubDevices, githubBackups, NEED_PASS, type BackupFile, type GhDevice } from '../lib/backup'
import { checkForUpdate, checking } from '../lib/updater'
import { appVersion } from '../lib/version'
import LicenseAdmin from '../components/LicenseAdmin.vue'
import LogViewer from '../components/LogViewer.vue'
import PinPad from '../components/PinPad.vue'
import QrScanButton from '../components/QrScanButton.vue'
import { confirmDialog } from '../lib/confirm'
import { notify } from '../lib/notify'

const currency = ref("so'm")
const allowNegative = ref(false)
const keepCart = ref(false)
const shopName = ref('OpenSales POS')
// Browsersiz pechat: printerlar ro'yxati + tanlangan (bo'sh = brauzer orqali).
const printers = ref<string[]>([])
const receiptPrinter = ref('')
const labelPrinter = ref('')
async function loadPrinters() { try { printers.value = await listPrinters() } catch { printers.value = [] } }
const newPin = ref('')
const pinError = ref('')
const saved = ref(false)

const licKey = ref('')
const showAdmin = ref(false)
const keyTaps = ref(0)
function tapKey() { if (++keyTaps.value >= 5) { keyTaps.value = 0; showAdmin.value = true } }
const showLogs = ref(false)
const showBackup = ref(false)
const titleTaps = ref(0)
const askMaster = ref(false)
const masterInput = ref('')
const masterErr = ref('')
function tapTitle() { if (++titleTaps.value >= 5) { titleTaps.value = 0; askMaster.value = true; masterInput.value = ''; masterErr.value = '' } }
async function confirmMaster() {
  if (!isOwnerMaster(masterInput.value)) { masterErr.value = 'Master kalit noto\'g\'ri'; return }
  askMaster.value = false
  showBackup.value = true
  notify('Zaxira bo\'limi ochildi', 'success')
  await loadGhDevices()
}
const backups = ref<BackupFile[]>([])
const ghDevs = ref<GhDevice[]>([])
const ghDev = ref('')
const ghList = ref<BackupFile[]>([])
const ghBusy = ref(false)
async function loadGhDevices() {
  ghBusy.value = true
  try { ghDevs.value = await githubDevices(); if (ghDevs.value.length && !ghDev.value) { ghDev.value = ghDevs.value[0].id; await loadGhList() } }
  finally { ghBusy.value = false }
}
async function loadGhList() { ghList.value = ghDev.value ? await githubBackups(ghDev.value) : [] }
const ghItems = computed(() => ghDevs.value.map((d) => ({ value: d.id, label: d.label })))
watch(ghDev, loadGhList)
async function ghRestore(name: string) {
  if (!(await confirmDialog(`Cloud'dagi "${name}" nusxasidan tiklansinmi? Joriy ma'lumotlar almashtiriladi va dastur qayta ishga tushadi.`, { danger: true, title: 'Cloud\'dan tiklash' }))) return
  restoring.value = 'Cloud\'dan yuklab olinmoqda…'
  try { await githubDownload(ghDev.value, name); restoring.value = ''; await askRestorePin(name) }
  catch (e: any) {
    restoring.value = ''
    if (e?.message === NEED_PASS) { rpName.value = name; rpKey.value = ''; rpErr.value = ''; showRp.value = true }
    else notify('Yuklab bo\'lmadi: ' + (e?.message ?? e), 'error')
  }
}

// Cloud shifrlash (owner master = parol). Lokal nusxa ochiq, cloud nusxa shifrlanadi.
const encOn = ref(false)
async function loadEnc() { encOn.value = (await getSetting('backup_pass', '')) !== '' }
const showEncSet = ref(false)
const encKey = ref('')
const encErr = ref('')
function normPass(s: string) { return s.trim().toUpperCase() }
async function enableEnc() {
  if (!isOwnerMaster(encKey.value)) { encErr.value = 'Master kalit noto\'g\'ri'; return }
  await setSetting('backup_pass', normPass(encKey.value)) // owner master = shifrlash paroli
  encOn.value = true; showEncSet.value = false; encKey.value = ''; encErr.value = ''
  notify('Cloud shifrlash yoqildi', 'success')
}
async function disableEnc() {
  if (!(await confirmDialog('Cloud shifrlash o\'chirilsinmi? Yangi nusxalar OCHIQ yuklanadi.', { danger: true, title: 'Shifrlashni o\'chirish' }))) return
  await setSetting('backup_pass', '')
  encOn.value = false
  notify('Shifrlash o\'chirildi', 'success')
}

// Boshqa kompda shifrlangan nusxani tiklash — owner master parol so'raladi.
const showRp = ref(false)
const rpName = ref('')
const rpKey = ref('')
const rpErr = ref('')
async function submitRp() {
  restoring.value = 'Ochilmoqda…'
  try {
    await githubDownload(ghDev.value, rpName.value, normPass(rpKey.value))
    showRp.value = false; restoring.value = ''
    await askRestorePin(rpName.value)
  } catch (e: any) {
    restoring.value = ''
    rpErr.value = e?.message === NEED_PASS ? 'Parol kerak' : (e?.message ?? 'Xato')
  }
}
const busyBackup = ref(false)
async function loadBackups() { backups.value = await listBackups() }
async function backupNow() {
  busyBackup.value = true
  try { const n = await makeBackup(); await loadBackups(); notify('Nusxa olindi: ' + n, 'success') }
  catch (e: any) { notify('Xato: ' + (e?.message ?? e), 'error') }
  finally { busyBackup.value = false }
}
const restoring = ref('')
async function doRestore(f: BackupFile) {
  if (!(await confirmDialog(`"${f.name}" nusxasidan tiklansinmi? Joriy ma'lumotlar shu nusxa bilan almashtiriladi va dastur qayta ishga tushadi.`, { danger: true, title: 'Bazani tiklash' }))) return
  await askRestorePin(f.name)
}

// --- Tiklash PIN tekshiruvi: o'sha nusxa ichidagi PIN talab qilinadi; owner master bilan chetlab o'tadi ---
const verifyOpen = ref(false)
const pendingRestore = ref('')
const expectedPin = ref<string | null>(null)
const verifyPad = ref<InstanceType<typeof PinPad>>()
const verifyErr = ref(false)
const ownerMode = ref(false)
const ownerKey = ref('')
const ownerErr = ref('')
const verifyIconTaps = ref(0)
// Yashirin: shield ikonkani 5 marta bossa → master kalit kiritish (owner bypass).
function tapVerifyIcon() { if (++verifyIconTaps.value >= 5) { verifyIconTaps.value = 0; ownerMode.value = true } }
async function askRestorePin(name: string) {
  expectedPin.value = await backupPin(name)
  pendingRestore.value = name
  verifyErr.value = false
  verifyIconTaps.value = 0
  ownerMode.value = expectedPin.value === null // PIN o'qib bo'lmasa faqat owner tiklay oladi
  ownerKey.value = ''; ownerErr.value = ''
  verifyOpen.value = true
}
async function onVerifyPin(p: string) {
  if (expectedPin.value && p === expectedPin.value) await applyRestore()
  else { verifyErr.value = true; verifyPad.value?.shakeNow(); setTimeout(() => (verifyErr.value = false), 600) }
}
function unlockOwner() {
  if (isOwnerMaster(ownerKey.value)) applyRestore()
  else ownerErr.value = 'Master kalit noto\'g\'ri'
}
async function applyRestore() {
  verifyOpen.value = false
  restoring.value = 'Tiklanmoqda…'
  try { await restoreBackup(pendingRestore.value) } catch (e: any) { restoring.value = ''; notify('Tiklashda xato: ' + (e?.message ?? e), 'error') }
}
// Bazadan yangi nusxa olib GitHub'ga yuboradi (header + zaxira bo'limi tugmasi).
async function syncNow() {
  if (syncing.value) return
  const ok = await libSyncNow()
  notify(ok ? 'Baza Cloud\'ga yuklandi' : 'Sync bo\'lmadi (internet yoki litsenziya yo\'q)', ok ? 'success' : 'error')
  if (ok) { await loadBackups(); if (showBackup.value) await loadGhDevices() }
}
async function checkUpdate() {
  const r = await checkForUpdate()
  if (r === 'available') return // burchakdagi banner ko'rsatadi
  if (r === 'latest') notify(`Eng so'nggi versiya o'rnatilgan (v${appVersion.value})`, 'success')
  else if (r === 'offline') notify('Internet aloqasi yo\'q', 'error')
  else notify('Tekshirib bo\'lmadi (server yoki tarmoq xatosi)', 'error')
}
const licText = computed(() => {
  const l = license.value
  if (l.mode === 'licensed') return l.forever ? 'Faol · cheksiz' : `Faol · ${l.until} gacha (${l.daysLeft} kun)`
  if (l.mode === 'trial') return `Sinov muddati · ${l.daysLeft} kun qoldi`
  return 'Muddati tugagan'
})

onMounted(async () => {
  currency.value = await getSetting('currency_symbol', "so'm")
  allowNegative.value = (await getSetting('allow_negative_stock', '0')) === '1'
  keepCart.value = (await getSetting('keep_cart', '0')) === '1'
  shopName.value = await getSetting('shop_name', 'OpenSales POS')
  receiptPrinter.value = await getSetting('receipt_printer', '')
  labelPrinter.value = await getSetting('label_printer', '')
  await loadPrinters()
  await refreshLicense()
  await loadBackups()
  await loadLastSync()
  await loadEnc()
})

async function applyKey() {
  const r = await activate(licKey.value)
  notify(r.msg, r.ok ? 'success' : 'error')
  if (r.ok) licKey.value = ''
}
async function copyDevice() { try { await navigator.clipboard.writeText(license.value.deviceId); notify('Nusxalandi', 'success') } catch {} }

async function save() {
  pinError.value = ''
  if (newPin.value.trim()) {
    if (!/^\d{4}$/.test(newPin.value.trim())) { pinError.value = "4 ta raqam bo'lishi kerak"; return }
    await setSetting('auth_pin', newPin.value.trim())
    newPin.value = ''
  }
  await setSetting('currency_symbol', currency.value || "so'm")
  await setSetting('allow_negative_stock', allowNegative.value ? '1' : '0')
  await setSetting('keep_cart', keepCart.value ? '1' : '0')
  await setSetting('shop_name', shopName.value || 'OpenSales POS')
  await setSetting('receipt_printer', receiptPrinter.value || '')
  await setSetting('label_printer', labelPrinter.value || '')
  setCurrency(currency.value)
  saved.value = true
  setTimeout(() => (saved.value = false), 2000)
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="page-header flex items-center justify-between gap-2">
      <div class="min-w-0">
        <h1 class="cursor-default truncate text-lg font-semibold select-none" @click="tapTitle">Sozlamalar</h1>
        <p class="hidden text-sm text-muted-foreground sm:block">Oxirgi sync: {{ lastSync ? formatDateTime(lastSync) : 'hali yo\'q' }}</p>
      </div>
      <div class="flex items-center gap-2 sm:gap-3">
        <span v-if="saved" class="flex items-center gap-1 text-sm text-emerald-600"><Check class="h-4 w-4" /> <span class="hidden sm:inline">Saqlandi</span></span>
        <button @click="syncNow" :disabled="syncing" class="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted disabled:opacity-60">
          <component :is="syncing ? RefreshCw : CloudUpload" class="h-4 w-4" :class="syncing ? 'animate-spin' : ''" /> <span class="hidden sm:inline">{{ syncing ? 'Yuklanmoqda…' : 'Sync' }}</span>
        </button>
        <button @click="showLogs = true" class="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted"><FileText class="h-4 w-4" /> <span class="hidden sm:inline">Loglar</span></button>
        <button @click="save" class="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 sm:px-5">Saqlash</button>
      </div>
    </header>

    <div class="flex-1 overflow-auto p-4 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] sm:p-6 lg:pb-6">
      <div class="mx-auto grid max-w-4xl gap-4 sm:gap-5 lg:grid-cols-2">
        <!-- Do'kon -->
        <section class="rounded-xl border bg-card p-4 sm:p-5">
          <div class="mb-4 flex items-center gap-2 text-sm font-semibold"><Store class="h-4 w-4 text-primary" /> Do'kon</div>
          <div class="space-y-4">
            <div>
              <label class="mb-1.5 block text-sm font-medium">Do'kon nomi</label>
              <input v-model="shopName" class="h-10 w-full rounded-lg border bg-background px-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
              <p class="mt-1 text-xs text-muted-foreground">Chek va dastur sarlavhasida ko'rinadi</p>
            </div>
          </div>
        </section>

        <!-- Valyuta -->
        <section class="rounded-xl border bg-card p-4 sm:p-5">
          <div class="mb-4 flex items-center gap-2 text-sm font-semibold"><Coins class="h-4 w-4 text-primary" /> Valyuta</div>
          <label class="mb-1.5 block text-sm font-medium">Belgisi</label>
          <input v-model="currency" placeholder="so'm" class="h-10 w-full rounded-lg border bg-background px-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
          <div class="mt-3 flex gap-1.5">
            <button v-for="c in [`so'm`, '₽', '$', '€']" :key="c" @click="currency = c" class="rounded-md border px-3 py-1 text-sm hover:bg-muted" :class="currency === c ? 'border-primary bg-primary/10 text-primary' : ''">{{ c }}</button>
          </div>
        </section>

        <!-- Sotuv -->
        <section class="rounded-xl border bg-card p-4 sm:p-5">
          <div class="mb-4 flex items-center gap-2 text-sm font-semibold"><ShoppingCart class="h-4 w-4 text-primary" /> Sotuv</div>
          <div class="space-y-4">
            <label class="flex items-center justify-between gap-4">
              <div>
                <div class="text-sm font-medium">Ostatkasiz sotish</div>
                <div class="text-xs text-muted-foreground">Qoldiq 0 bo'lsa ham sotishga ruxsat</div>
              </div>
              <button type="button" @click="allowNegative = !allowNegative" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="allowNegative ? 'bg-primary' : 'bg-muted'">
                <span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform" :class="allowNegative ? 'translate-x-5' : ''"></span>
              </button>
            </label>
            <label class="flex items-center justify-between gap-4">
              <div>
                <div class="text-sm font-medium">Savatni eslab qolish</div>
                <div class="text-xs text-muted-foreground">Boshqa bo'limga o'tib qaytganda savat va mijoz saqlanadi</div>
              </div>
              <button type="button" @click="keepCart = !keepCart" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="keepCart ? 'bg-primary' : 'bg-muted'">
                <span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform" :class="keepCart ? 'translate-x-5' : ''"></span>
              </button>
            </label>
          </div>
        </section>

        <!-- Printer (browsersiz pechat) -->
        <section class="rounded-xl border bg-card p-4 sm:p-5 lg:col-span-2">
          <div class="mb-4 flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 text-sm font-semibold"><Printer class="h-4 w-4 text-primary" /> Printer</div>
            <button @click="loadPrinters" class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-muted"><RefreshCw class="h-3.5 w-3.5" /> Yangilash</button>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="mb-1.5 block text-sm font-medium">Chek printeri</label>
              <select v-model="receiptPrinter" class="h-10 w-full rounded-lg border bg-background px-3 text-sm">
                <option value="">Brauzer orqali (standart)</option>
                <option v-for="p in printers" :key="p" :value="p">{{ p }}</option>
              </select>
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-medium">Yorliq (nakleyka) printeri</label>
              <select v-model="labelPrinter" class="h-10 w-full rounded-lg border bg-background px-3 text-sm">
                <option value="">Brauzer orqali (standart)</option>
                <option v-for="p in printers" :key="p" :value="p">{{ p }}</option>
              </select>
            </div>
          </div>
          <p class="mt-2 text-xs text-muted-foreground">
            Printer tanlansa — brauzer ochilmasdan to'g'ridan-to'g'ri chop etiladi. Bo'sh qolsa eski usul (brauzerда auto-print).
            <template v-if="printers.length === 0"><br>Printer topilmadi — O'rnatilganini tekshiring, so'ng «Yangilash».</template>
          </p>
        </section>

        <!-- Xavfsizlik -->
        <section class="rounded-xl border bg-card p-4 sm:p-5">
          <div class="mb-4 flex items-center gap-2 text-sm font-semibold"><ShieldCheck class="h-4 w-4 text-primary" /> Xavfsizlik</div>
          <label class="mb-1.5 block text-sm font-medium">Yangi PIN-kod</label>
          <input v-model="newPin" inputmode="numeric" maxlength="4" placeholder="• • • •" class="h-10 w-32 rounded-lg border bg-background px-3 text-center text-sm tracking-[0.4em] focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
          <p class="mt-1 text-xs text-muted-foreground">O'zgartirmaslik uchun bo'sh qoldiring</p>
          <div v-if="pinError" class="mt-1 text-xs text-rose-600">{{ pinError }}</div>
        </section>

        <!-- Litsenziya -->
        <section class="rounded-xl border bg-card p-4 sm:p-5 lg:col-span-2">
          <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2 text-sm font-semibold"><button @click="tapKey" class="rounded p-0.5"><KeyRound class="h-4 w-4 text-primary" /></button> Litsenziya</div>
            <span class="rounded-full px-2.5 py-0.5 text-xs font-medium"
              :class="license.mode === 'licensed' ? 'bg-emerald-500/15 text-emerald-600' : license.mode === 'trial' ? 'bg-amber-500/15 text-amber-600' : 'bg-rose-500/15 text-rose-600'">{{ licText }}</span>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="mb-1.5 block text-sm font-medium">Qurilma ID</label>
              <div class="flex items-center gap-2">
                <div class="flex h-10 flex-1 items-center rounded-lg border bg-muted/40 px-3 font-mono text-sm tabular-nums">{{ license.deviceId }}</div>
                <button @click="copyDevice" class="flex h-10 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted"><Copy class="h-4 w-4" /></button>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">Yangi kalit olish uchun sotuvchiga shu ID ni yuboring</p>
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-medium">Aktivatsiya kaliti</label>
              <div class="flex items-center gap-2">
                <input v-model="licKey" placeholder="Kalitni joylang" class="h-10 min-w-0 flex-1 rounded-lg border bg-background px-3 font-mono text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
                <QrScanButton @decoded="licKey = $event" />
                <button @click="applyKey" :disabled="!licKey.trim()" class="h-10 shrink-0 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:px-4">Faollashtirish</button>
              </div>
            </div>
          </div>
        </section>

        <!-- Zaxira nusxa (maxfiy — sarlavhani 5 marta bosish) -->
        <section v-if="showBackup" class="rounded-xl border bg-card p-4 sm:p-5 lg:col-span-2">
          <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2 text-sm font-semibold"><DatabaseBackup class="h-4 w-4 text-primary" /> Zaxira nusxa (backup)</div>
            <div class="flex flex-1 items-center gap-2 sm:flex-none">
              <button @click="syncNow" :disabled="syncing" class="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted disabled:opacity-60 sm:flex-none">
                <component :is="syncing ? RefreshCw : CloudUpload" class="h-4 w-4" :class="syncing ? 'animate-spin' : ''" /> {{ syncing ? 'Yuklanmoqda…' : 'Sync' }}
              </button>
              <button @click="backupNow" :disabled="busyBackup" class="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:flex-none"><DatabaseBackup class="h-4 w-4" /> <span class="whitespace-nowrap">Hozir nusxa olish</span></button>
            </div>
          </div>
          <p class="mb-3 text-xs text-muted-foreground">Har kuni avtomatik nusxa olinadi (oxirgi 14 ta saqlanadi). Internet bo'lsa Cloud'ga sync qilinadi. Tiklash uchun nusxani tanlang.</p>

          <!-- Cloud shifrlash (lokal ochiq, cloud nusxa parol bilan) -->
          <div class="mb-3 flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
            <div class="flex items-center gap-2 text-sm">
              <component :is="encOn ? Lock : LockOpen" class="h-4 w-4" :class="encOn ? 'text-emerald-600' : 'text-muted-foreground'" />
              <span>Cloud shifrlash: <b :class="encOn ? 'text-emerald-600' : 'text-muted-foreground'">{{ encOn ? 'Yoqilgan' : "O'chiq" }}</b></span>
            </div>
            <button @click="encOn ? disableEnc() : (showEncSet = true)" class="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted">{{ encOn ? "O'chirish" : 'Yoqish' }}</button>
          </div>
          <div class="grid gap-4 lg:grid-cols-2">
            <div>
              <div class="mb-1.5 text-xs font-medium text-muted-foreground">Bu kompdagi nusxalar</div>
              <div class="max-h-56 divide-y overflow-auto rounded-lg border">
                <div v-for="f in backups" :key="f.name" class="flex items-center justify-between px-3 py-2.5 text-sm hover:bg-muted/40">
                  <span class="font-mono text-xs">{{ f.name }}</span>
                  <button @click="doRestore(f)" class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-muted"><RotateCcw class="h-3.5 w-3.5" /> Tiklash</button>
                </div>
                <div v-if="backups.length === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">Hali nusxa yo'q</div>
              </div>
            </div>
            <div>
              <div class="mb-1.5 text-xs font-medium text-muted-foreground">Cloud'dan tiklash (yangi komp)</div>
              <div v-if="ghDevs.length" class="mb-2">
                <SearchableSelect v-model="ghDev" :items="ghItems" placeholder="Qurilmani tanlang" search-placeholder="Do'kon yoki kompyuter nomi…" />
              </div>
              <div class="max-h-56 divide-y overflow-auto rounded-lg border">
                <div v-if="ghBusy" class="px-3 py-6 text-center text-sm text-muted-foreground">Yuklanmoqda…</div>
                <template v-else>
                  <div v-for="f in ghList" :key="f.name" class="flex items-center justify-between px-3 py-2.5 text-sm hover:bg-muted/40">
                    <span class="font-mono text-xs">{{ f.name }}</span>
                    <button @click="ghRestore(f.name)" class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-muted"><RotateCcw class="h-3.5 w-3.5" /> Tiklash</button>
                  </div>
                  <div v-if="ghList.length === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">Cloud'da nusxa yo'q (yoki litsenziya yo'q)</div>
                </template>
              </div>
            </div>
          </div>
        </section>

        <!-- Yangilanish -->
        <section class="rounded-xl border bg-card p-4 sm:p-5 lg:col-span-2">
          <div class="flex items-center justify-between">
            <div>
              <div class="flex items-center gap-2 text-sm font-semibold"><Download class="h-4 w-4 text-primary" /> Yangilanish</div>
              <p class="mt-1 text-xs text-muted-foreground">Joriy versiya: v{{ appVersion }} · internet bo'lganda avtomatik tekshiriladi</p>
            </div>
            <button @click="checkUpdate" :disabled="checking" class="flex h-9 items-center gap-1.5 rounded-lg border px-3.5 text-sm hover:bg-muted disabled:opacity-50">
              <RefreshCw class="h-4 w-4" :class="checking ? 'animate-spin' : ''" /> Tekshirish
            </button>
          </div>
        </section>
      </div>
    </div>

    <!-- Tiklash jarayoni -->
    <div v-if="restoring" class="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-4 bg-background/90 backdrop-blur">
      <RefreshCw class="h-10 w-10 animate-spin text-primary" />
      <div class="text-sm font-medium">{{ restoring }}</div>
      <div class="text-xs text-muted-foreground">Dastur tez orada qayta ishga tushadi…</div>
    </div>

    <LicenseAdmin v-if="showAdmin" :device-id="license.deviceId" @close="showAdmin = false" />
    <LogViewer v-if="showLogs" @close="showLogs = false" />

    <!-- Zaxira bo'limi uchun master so'rovi -->
    <div v-if="askMaster" class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div class="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl border bg-card p-4 sm:p-5 shadow-xl">
        <div class="mb-1 flex items-center gap-2 text-lg font-semibold"><DatabaseBackup class="h-5 w-5 text-primary" /> Zaxira bo'limi</div>
        <p class="mb-4 text-sm text-muted-foreground">Faqat dastur egasi uchun. Master kalitni kiriting.</p>
        <div class="flex gap-2">
          <input v-model="masterInput" type="password" autofocus placeholder="Master kalit" class="h-11 w-full rounded-lg border bg-background px-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" @keyup.enter="confirmMaster" />
          <QrScanButton @decoded="masterInput = $event" />
        </div>
        <p v-if="masterErr" class="mt-1.5 text-sm text-rose-500">{{ masterErr }}</p>
        <div class="mt-4 flex gap-2">
          <button @click="confirmMaster" class="h-10 flex-1 rounded-lg bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Kirish</button>
          <button @click="askMaster = false" class="h-10 rounded-lg border px-4 text-sm hover:bg-muted">Bekor</button>
        </div>
      </div>
    </div>

    <!-- Tiklash tasdiqlash: o'sha nusxa ichidagi PIN yoki owner master kalit -->
    <div v-if="verifyOpen" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div class="max-h-[90vh] w-full max-w-xs overflow-y-auto rounded-xl border bg-card p-4 sm:p-5 shadow-xl">
        <div class="mb-1 flex items-center gap-2 text-lg font-semibold">
          <button @click="tapVerifyIcon" class="rounded p-0.5" title="Tiklashni tasdiqlang"><ShieldCheck class="h-5 w-5 text-primary" /></button> Tiklashni tasdiqlang
        </div>

        <template v-if="!ownerMode">
          <p class="mb-4 text-sm text-muted-foreground">Shu nusxadagi PIN-kodni kiriting.</p>
          <PinPad ref="verifyPad" :error="verifyErr" @complete="onVerifyPin" />
        </template>

        <template v-else>
          <p class="mb-4 text-sm text-muted-foreground">{{ expectedPin === null ? 'Bu nusxada PIN topilmadi. Faqat egasi tiklay oladi.' : 'Master kalit bilan ixtiyoriy nusxani tiklash.' }}</p>
          <div class="flex gap-2">
            <input v-model="ownerKey" type="password" autofocus placeholder="Master kalit" class="h-11 w-full rounded-lg border bg-background px-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" @keyup.enter="unlockOwner" />
            <QrScanButton @decoded="ownerKey = $event" />
          </div>
          <p v-if="ownerErr" class="mt-1.5 text-sm text-rose-500">{{ ownerErr }}</p>
          <button @click="unlockOwner" class="mt-3 h-10 w-full rounded-lg bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Tiklash</button>
          <button v-if="expectedPin !== null" @click="ownerMode = false; ownerErr = ''" class="mt-2 w-full text-xs text-muted-foreground hover:text-foreground">← PIN bilan</button>
        </template>

        <button @click="verifyOpen = false" class="mt-3 h-9 w-full rounded-lg border text-sm hover:bg-muted">Bekor</button>
      </div>
    </div>

    <!-- Cloud shifrlashni yoqish: owner master = parol -->
    <div v-if="showEncSet" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div class="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl border bg-card p-4 sm:p-5 shadow-xl">
        <div class="mb-1 flex items-center gap-2 text-lg font-semibold"><Lock class="h-5 w-5 text-primary" /> Cloud shifrlash</div>
        <p class="mb-4 text-sm text-muted-foreground">Owner master kalit shifrlash paroli bo'ladi. Cloud nusxa shu bilan shifrlanadi — serverda parol YO'Q. Boshqa kompda tiklashda shu kalit so'raladi. <b>Kalitni yo'qotmang</b> — aks holda cloud nusxa ochilmaydi.</p>
        <div class="flex gap-2">
          <input v-model="encKey" type="password" autofocus placeholder="Owner master kalit" class="h-11 w-full rounded-lg border bg-background px-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" @keyup.enter="enableEnc" />
          <QrScanButton @decoded="encKey = $event" />
        </div>
        <p v-if="encErr" class="mt-1.5 text-sm text-rose-500">{{ encErr }}</p>
        <div class="mt-4 flex gap-2">
          <button @click="enableEnc" class="h-10 flex-1 rounded-lg bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Yoqish</button>
          <button @click="showEncSet = false" class="h-10 rounded-lg border px-4 text-sm hover:bg-muted">Bekor</button>
        </div>
      </div>
    </div>

    <!-- Boshqa kompda shifrlangan nusxani ochish — parol -->
    <div v-if="showRp" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div class="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl border bg-card p-4 sm:p-5 shadow-xl">
        <div class="mb-1 flex items-center gap-2 text-lg font-semibold"><Lock class="h-5 w-5 text-primary" /> Shifrlangan nusxa</div>
        <p class="mb-4 text-sm text-muted-foreground">Bu nusxa shifrlangan. Ochish uchun owner master kalitni kiriting.</p>
        <div class="flex gap-2">
          <input v-model="rpKey" type="password" autofocus placeholder="Owner master kalit" class="h-11 w-full rounded-lg border bg-background px-3 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" @keyup.enter="submitRp" />
          <QrScanButton @decoded="rpKey = $event" />
        </div>
        <p v-if="rpErr" class="mt-1.5 text-sm text-rose-500">{{ rpErr }}</p>
        <div class="mt-4 flex gap-2">
          <button @click="submitRp" class="h-10 flex-1 rounded-lg bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Ochish</button>
          <button @click="showRp = false" class="h-10 rounded-lg border px-4 text-sm hover:bg-muted">Bekor</button>
        </div>
      </div>
    </div>
  </div>
</template>
