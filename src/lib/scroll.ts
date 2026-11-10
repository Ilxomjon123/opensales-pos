/**
 * Elementni aylantiradigan eng yaqin konteyner (o'zi yoki ajdodi); topilmasa null (viewport).
 *
 * Bo'laklab chizishdagi IntersectionObserver `root` i uchun: telefonda ro'yxat konteyneri
 * o'zi aylanmaydi (butun sahifa `main` bilan aylanadi, style.css → `.os-scroll`), desktopda
 * esa o'zi aylanadi. Qattiq `root: listBox` telefonda hamma qatorni birdan chizdirardi.
 */
export function scrollRoot(el: HTMLElement | null): HTMLElement | null {
  for (let n = el; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY
    if (o === 'auto' || o === 'scroll') return n
  }
  return null
}
