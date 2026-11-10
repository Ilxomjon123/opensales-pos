import { ref } from 'vue'

// Sahifalar xotirada saqlanadi (App.vue → KeepAlive) — qayta kirishda darhol ko'rinadi. Har muvaffaqiyatli
// yozuvdan keyin versiya oshadi: shundan keyin qayta kirilgan (joriy bo'lmagan) sahifa yangidan yuklanadi —
// eskirgan sotuv/qoldiq ko'rsatilmaydi. Joriy sahifa o'z yozuvi tufayli qayta yaratilmaydi.
export const dataVersion = ref(0)

export function bumpData() {
  dataVersion.value++
}
