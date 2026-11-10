<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { UserPlus, Send, Copy, Ban, Crown, UserRound } from 'lucide-vue-next'
import { api, RpcError } from '../rpc'
import { session } from '../session'
import { openTelegramLink, haptic } from '../telegram'
import { notify } from '../../../src/lib/notify'
import { confirmDialog } from '../../../src/lib/confirm'

// Xodimlar (faqat egalar): taklif havolasi (bir martalik, 7 kun) — kassir yoki EGASI (boshqa Telegram
// akkauntni to'liq huquq bilan ulash: sherik yoki egasining ikkinchi raqami). "Egasi" taklifini va
// ikkinchi egalarni yoqish/o'chirishni faqat asosiy ega (do'konni ochgan) qiladi — server tekshiradi.
type Role = 'owner' | 'cashier'
type Member = { uid: number; name: string; username: string | null; role: Role; active: number; created_at: string; primary: boolean }
const { t } = useI18n()
const members = ref<Member[]>([])
const invites = ref<{ role: Role; created_at: string; expires_at: string }[]>([])
const canManageOwners = ref(false)
const role = ref<Role>('cashier')
const link = ref('')
const linkRole = ref<Role>('cashier')
const loading = ref(true)

function fail(e: unknown) {
  notify(e instanceof RpcError ? t(e.code, e.params) : String(e), 'error')
}

async function load() {
  try {
    const d = await api<{ members: Member[]; invites: typeof invites.value; canManageOwners: boolean }>('/api/staff/list')
    members.value = d.members
    invites.value = d.invites
    canManageOwners.value = d.canManageOwners
  } catch (e) { fail(e) } finally { loading.value = false }
}
onMounted(load)

function pickRole(r: Role) { role.value = r; haptic('select') }

async function invite() {
  try {
    const d = await api<{ link: string; role: Role }>('/api/staff/invite', { role: role.value })
    link.value = d.link
    linkRole.value = d.role
    haptic('success')
    await load()
  } catch (e) { fail(e) }
}

const shareText = computed(() => t(linkRole.value === 'owner' ? 'cloud.staff.shareTextOwner' : 'cloud.staff.shareText'))
function share() {
  openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link.value)}&text=${encodeURIComponent(shareText.value)}`)
}
async function copy() {
  try { await navigator.clipboard.writeText(link.value); notify(t('cloud.staff.copied'), 'success') } catch { /* ruxsat yo'q */ }
}
async function revokeAll() {
  if (!(await confirmDialog(t('cloud.staff.revokeInvites') + '?', { danger: true }))) return
  try { await api('/api/staff/revoke-invites'); link.value = ''; await load() } catch (e) { fail(e) }
}
/** Kim kimni boshqaradi: o'zini va asosiy egani — hech kim; ikkinchi egani — faqat asosiy ega. */
const canToggle = (m: Member) => m.uid !== session.user?.uid && !m.primary && (m.role === 'cashier' || canManageOwners.value)
async function setActive(m: Member, active: boolean) {
  if (!active && !(await confirmDialog(`${m.name}: ${t('cloud.staff.disable')}?`, { danger: true }))) return
  try { await api('/api/staff/set-active', { uid: m.uid, active }); await load() } catch (e) { fail(e) }
}
</script>

<template>
  <div class="min-h-full">
    <header class="page-header">
      <h1 class="text-lg font-semibold">{{ $t('cloud.staff.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ $t('cloud.staff.subtitle') }}</p>
    </header>

    <div class="mx-auto max-w-xl space-y-4 p-4">
      <section class="rounded-2xl border bg-card p-4">
        <!-- Rol: kassir yoki egasi (boshqa akkaunt). Egasi taklifi — faqat asosiy egaga. -->
        <div v-if="canManageOwners" class="staff-seg mb-3" role="radiogroup">
          <span class="staff-seg-lens" :style="{ transform: role === 'owner' ? 'translateX(100%)' : 'none' }" aria-hidden="true" />
          <button type="button" role="radio" :aria-checked="role === 'cashier'" :class="{ on: role === 'cashier' }" @click="pickRole('cashier')">
            <UserRound class="h-4 w-4" /> {{ $t('cloud.staff.roleCashier') }}
          </button>
          <button type="button" role="radio" :aria-checked="role === 'owner'" :class="{ on: role === 'owner' }" @click="pickRole('owner')">
            <Crown class="h-4 w-4" /> {{ $t('cloud.staff.roleOwner') }}
          </button>
        </div>
        <p class="mb-3 text-xs leading-relaxed text-muted-foreground" :class="role === 'owner' ? '!text-amber-600 dark:!text-amber-400' : ''">
          {{ role === 'owner' ? $t('cloud.staff.hintOwner') : $t('cloud.staff.hintCashier') }}
        </p>
        <button @click="invite" class="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground">
          <component :is="role === 'owner' ? Crown : UserPlus" class="h-4 w-4" />
          {{ role === 'owner' ? $t('cloud.staff.inviteOwner') : $t('cloud.staff.invite') }}
        </button>
        <p class="mt-2 text-center text-xs text-muted-foreground">{{ $t('cloud.staff.inviteHint') }}</p>
        <Transition name="os-modal">
          <div v-if="link" class="mt-3 space-y-2">
            <div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <component :is="linkRole === 'owner' ? Crown : UserRound" class="h-3.5 w-3.5" />
              {{ linkRole === 'owner' ? $t('cloud.staff.roleOwner') : $t('cloud.staff.roleCashier') }}
            </div>
            <div class="break-all rounded-lg bg-muted/50 p-2.5 font-mono text-xs">{{ link }}</div>
            <div class="grid grid-cols-2 gap-2">
              <button @click="share" class="flex h-10 items-center justify-center gap-2 rounded-lg border text-sm font-medium"><Send class="h-4 w-4" /> {{ $t('cloud.staff.share') }}</button>
              <button @click="copy" class="flex h-10 items-center justify-center gap-2 rounded-lg border text-sm font-medium"><Copy class="h-4 w-4" /> {{ $t('cloud.staff.copy') }}</button>
            </div>
          </div>
        </Transition>
        <div v-if="invites.length" class="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>{{ $t('cloud.staff.pending', { count: invites.length }) }}</span>
          <button @click="revokeAll" class="flex items-center gap-1 text-rose-600"><Ban class="h-3.5 w-3.5" /> {{ $t('cloud.staff.revokeInvites') }}</button>
        </div>
      </section>

      <section class="os-list !m-0 divide-y rounded-2xl border bg-card">
        <div v-if="loading" class="space-y-2 p-4">
          <div class="h-10 animate-pulse rounded-lg bg-muted" />
          <div class="h-10 animate-pulse rounded-lg bg-muted" />
        </div>
        <div v-for="m in members" v-else :key="m.uid" class="flex items-center gap-3 p-4">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full" :class="m.role === 'owner' ? 'bg-amber-500/15 text-amber-600' : 'bg-muted text-muted-foreground'">
            <component :is="m.role === 'owner' ? Crown : UserRound" class="h-[18px] w-[18px]" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 truncate text-sm font-semibold">
              <span class="truncate">{{ m.name }}</span>
              <span v-if="m.uid === session.user?.uid" class="shrink-0 font-normal text-muted-foreground">({{ $t('cloud.staff.you') }})</span>
              <span v-if="m.primary" class="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">{{ $t('cloud.staff.primary') }}</span>
            </div>
            <div class="truncate text-xs text-muted-foreground">
              {{ $t(`cloud.settings.role.${m.role}`) }}<template v-if="m.username"> · @{{ m.username }}</template>
              · <span :class="m.active ? 'text-emerald-600' : 'text-rose-600'">{{ m.active ? $t('cloud.staff.active') : $t('cloud.staff.disabled') }}</span>
            </div>
          </div>
          <button v-if="canToggle(m)" @click="setActive(m, !m.active)"
            class="h-9 rounded-lg border px-3 text-xs font-medium" :class="m.active ? 'text-rose-600' : ''">
            {{ m.active ? $t('cloud.staff.disable') : $t('cloud.staff.enable') }}
          </button>
        </div>
        <div v-if="!loading && members.length <= 1" class="p-4 text-center text-sm text-muted-foreground">{{ $t('cloud.staff.empty') }}</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* Rol tanlash — shisha segment, tanlangan tomonga linza siljiydi (pastki panel kabi). */
.staff-seg {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 4px;
  border-radius: 9999px;
  background: var(--accent);
  box-shadow: inset 0 1px 0 var(--glass-edge, transparent), inset 0 0 0 0.5px var(--glass-rim, transparent);
}
.staff-seg-lens {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc(50% - 4px);
  border-radius: 9999px;
  background: var(--lens-fill, var(--card));
  box-shadow: inset 0 1px 0 var(--glass-edge, transparent), inset 0 0 0 0.5px var(--glass-rim, transparent), 0 4px 12px -4px rgb(0 0 0 / 0.2);
  transition: transform 0.4s cubic-bezier(0.34, 1.32, 0.5, 1);
}
.staff-seg button {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 2.5rem;
  border-radius: 9999px;
  font-size: 0.875rem;
  font-weight: 600;
  opacity: 0.6;
}
.staff-seg button.on {
  opacity: 1;
}
</style>
