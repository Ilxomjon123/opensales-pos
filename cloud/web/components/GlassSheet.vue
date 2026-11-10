<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { haptic } from '../telegram'

// Pastdan chiqadigan shisha varaq (hostel mini app'idagi picker kabi): select, sana va
// qidiruvli tanlash shu ichida ochiladi. Fon bosilsa yoki Esc — yopiladi.
const props = defineProps<{ open: boolean; title?: string; sub?: string; tall?: boolean }>()
const emit = defineEmits<{ close: [] }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.stopPropagation(); emit('close') }
}
watch(() => props.open, (o) => {
  if (o) { haptic('light'); window.addEventListener('keydown', onKey, true) }
  else window.removeEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="glass-sheet">
      <div v-if="open" class="glass-sheet-layer" @click.self="emit('close')">
        <div class="glass-sheet" :class="{ tall }" role="dialog" aria-modal="true" :aria-label="title">
          <div class="glass-sheet-grip" />
          <div class="glass-sheet-head">
            <div class="min-w-0 flex-1">
              <h2 v-if="title" class="truncate">{{ title }}</h2>
              <div v-if="sub" class="sub truncate">{{ sub }}</div>
            </div>
            <button type="button" class="glass-sheet-close" :aria-label="$t('cloud.field.close')" @click="emit('close')"><X class="h-[18px] w-[18px]" /></button>
          </div>
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
