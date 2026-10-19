<script setup lang="ts">
// Vozvrat pulining taqsimoti: qancha balansga (qarzdan ayiriladi), qolgani naqd/karta.
// Chek bo'yicha ham, mijoz bo'yicha ham bir xil — chegaralar Rust'dan keladi.
import { computed } from 'vue'
import { moneySum } from '../lib/format'
import { clampRefundBalance } from '../lib/returns'

const props = defineProps<{
  amount: number
  moneyCap: number
  balanceAllowed: boolean
  customerBalance: number
  balance: number
  method: 'cash' | 'card'
}>()
const emit = defineEmits<{ 'update:balance': [v: number]; 'update:method': [v: 'cash' | 'card'] }>()

const balanceMin = computed(() => Math.max(0, props.amount - props.moneyCap))
const moneyPart = computed(() => Math.max(0, props.amount - props.balance))
const signedBalance = computed(() => (props.customerBalance < 0 ? '− ' + moneySum(-props.customerBalance) : moneySum(props.customerBalance)))

function onBalance(raw: string) {
  emit('update:balance', clampRefundBalance(Number(raw), props.amount, props.moneyCap, props.balanceAllowed))
}
</script>

<template>
  <template v-if="amount > 0">
    <div v-if="balanceAllowed" class="space-y-1">
      <label class="flex items-baseline justify-between text-sm font-medium">
        <span>{{ $t('returns.toBalance') }}</span>
        <span class="text-xs font-normal text-muted-foreground">{{ $t('returns.customerBalance', { amount: signedBalance }) }}</span>
      </label>
      <input type="number" :min="balanceMin" :max="amount" :value="balance" @change="onBalance(($event.target as HTMLInputElement).value)"
        class="h-10 w-full rounded-md border bg-background px-3 text-sm tabular-nums" />
      <p class="text-xs text-muted-foreground">{{ $t('returns.balanceDebtHint') }} · {{ $t('returns.moneyCapHint', { amount: moneySum(moneyCap) }) }}</p>
    </div>
    <p v-else class="text-xs text-muted-foreground">{{ $t('returns.walkInMoneyOnly') }}</p>

    <div v-if="moneyPart > 0" class="flex flex-wrap items-center justify-between gap-2">
      <span class="text-sm font-medium">{{ $t('returns.moneyPart') }}: <span class="tabular-nums">{{ moneySum(moneyPart) }}</span></span>
      <div class="flex gap-1.5">
        <button @click="emit('update:method', 'cash')" class="h-9 rounded-md border px-3 text-sm" :class="method === 'cash' ? 'border-primary bg-primary/10 text-primary' : ''">{{ $t('returns.cash') }}</button>
        <button @click="emit('update:method', 'card')" class="h-9 rounded-md border px-3 text-sm" :class="method === 'card' ? 'border-primary bg-primary/10 text-primary' : ''">{{ $t('returns.card') }}</button>
      </div>
    </div>
  </template>
</template>
