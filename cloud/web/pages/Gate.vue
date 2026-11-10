<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Store, Send, UserX, RefreshCw } from 'lucide-vue-next'
import logo from '../../../src/assets/logo-dark.svg'
import { session, start, onboard } from '../session'
import { haptic } from '../telegram'

// Kirish ekrani: yuklanish, Telegram'dan tashqarida ochilganda, yangi foydalanuvchi
// (do'kon ochish), kirish o'chirilgan yoki xato.
const { t } = useI18n()
const shopName = ref('')
const busy = ref(false)
const formError = ref('')

const errorText = computed(() => (session.error ? t(session.error, session.errorParams) : ''))

async function submit() {
  const name = shopName.value.trim()
  if (name.length < 2 || busy.value) return
  busy.value = true
  formError.value = ''
  try {
    await onboard(name)
    haptic('success')
  } catch (e) {
    formError.value = t(e instanceof Error ? e.message : 'cloud.errors.internal')
    haptic('error')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex min-h-[var(--app-h)] flex-col items-center justify-center bg-background px-6 py-10 text-foreground">
    <div class="mb-6 h-16 w-16 overflow-hidden rounded-2xl shadow-md ring-1 ring-black/10">
      <img :src="logo" class="h-full w-full" alt="OpenSales" />
    </div>

    <!-- Yuklanmoqda: skelet, aylanuvchi belgi emas -->
    <div v-if="session.status === 'loading'" class="w-full max-w-sm space-y-3">
      <div class="mx-auto h-5 w-40 animate-pulse rounded bg-muted" />
      <div class="h-24 animate-pulse rounded-2xl bg-muted" />
      <div class="h-12 animate-pulse rounded-xl bg-muted" />
    </div>

    <div v-else-if="session.status === 'noTelegram'" class="max-w-sm text-center">
      <Send class="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
      <h1 class="text-lg font-bold">{{ $t('cloud.openInTelegram') }}</h1>
      <p class="mt-2 text-sm text-muted-foreground">{{ $t('cloud.openInTelegramHint') }}</p>
    </div>

    <form v-else-if="session.status === 'new'" class="w-full max-w-sm" @submit.prevent="submit">
      <h1 class="text-center text-xl font-bold">{{ $t('cloud.onboardTitle') }}</h1>
      <p class="mt-2 text-center text-sm text-muted-foreground">{{ $t('cloud.onboardHint') }}</p>
      <label class="mt-6 mb-1.5 block text-sm font-medium">{{ $t('cloud.shopName') }}</label>
      <div class="relative">
        <Store class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input v-model="shopName" maxlength="80" autofocus :placeholder="$t('cloud.shopNamePlaceholder')"
          class="h-12 w-full rounded-xl border bg-background pr-3 pl-9 text-base focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" />
      </div>
      <p v-if="formError" class="mt-2 text-sm text-rose-600">{{ formError }}</p>
      <button type="submit" :disabled="shopName.trim().length < 2 || busy"
        class="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-semibold text-primary-foreground disabled:opacity-50">
        {{ busy ? '…' : $t('cloud.start') }}
      </button>
      <p class="mt-3 text-center text-xs text-muted-foreground">{{ $t('cloud.freeTrial') }}</p>
    </form>

    <div v-else-if="session.status === 'revoked'" class="max-w-sm text-center">
      <UserX class="mx-auto mb-3 h-8 w-8 text-rose-600" />
      <h1 class="text-lg font-bold">{{ $t('cloud.revoked') }}</h1>
      <p class="mt-2 text-sm text-muted-foreground">{{ $t('cloud.revokedHint') }}</p>
    </div>

    <div v-else class="max-w-sm text-center">
      <p class="text-sm text-rose-600">{{ errorText }}</p>
      <button @click="start()" class="mt-4 inline-flex h-11 items-center gap-2 rounded-xl border px-5 text-sm font-medium">
        <RefreshCw class="h-4 w-4" /> {{ $t('cloud.retry') }}
      </button>
    </div>
  </div>
</template>
