import { moneySum, formatDateTime } from './format'
import { t } from './i18n'
import type { PrintReceipt } from './print'

// Chek chizish — desktop (termal PNG, print.ts) va Telegram versiyasi (chek rasmi, cloud/web/lib/print.ts) uchun bitta manba.

/** Mijoz saldosi chek uchun: manfiy — qarzdor, musbat — haqdor. */
export function balanceText(b: number): string {
  return moneySum(Math.abs(b)) + (b < 0 ? ` · ${t('pos.debtor')}` : b > 0 ? ` · ${t('pos.creditor')}` : '')
}

// Chek turi bo'yicha sarlavha va qator nomlari — uchala renderer (HTML, PNG, BLE) shuni ishlatadi.
export function receiptLabels(r: PrintReceipt) {
  const ret = r.kind === 'return'
  return {
    title: ret ? t('print.returnReceipt') : t('print.receipt'),
    original: ret && r.original_receipt ? `${t('print.originalReceipt')} #${r.original_receipt}` : '',
    total: ret ? t('print.refundTotal') : t('print.total'),
    cash: ret ? t('print.refundCash') : t('print.cash'),
    card: ret ? t('print.refundCard') : t('print.card'),
    debt: ret ? t('print.refundBalance') : t('print.debt'),
    foot: ret ? '' : t('print.thankYou'),
  }
}

// Matnни kenglikга sig'dirib qatorларга bo'lish. Uzun so'z (probelsiz) ham belgilab kesiladi.
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = []
  let cur = ''
  const push = () => { if (cur) { lines.push(cur); cur = '' } }
  for (const word of String(text).split(/\s+/)) {
    let w = word
    // Bitta qatorга sig'maydigan uzun so'zni belgilab bo'lakla.
    while (ctx.measureText(w).width > maxW) {
      push()
      let i = 1
      while (i < w.length && ctx.measureText(w.slice(0, i + 1)).width <= maxW) i++
      lines.push(w.slice(0, i))
      w = w.slice(i)
    }
    if (!w) continue
    const t = cur ? cur + ' ' + w : w
    if (ctx.measureText(t).width > maxW && cur) { push(); cur = w }
    else cur = t
  }
  push()
  return lines.length ? lines : ['']
}

// Matnни maxLines qatorга cheklab, oxirgisini sig'dirib "…" qo'shadi.
export function clampLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const all = wrapText(ctx, text, maxW)
  if (all.length <= maxLines) return all
  const out = all.slice(0, maxLines)
  let last = out[maxLines - 1]
  while (last.length && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1)
  out[maxLines - 1] = last + '…'
  return out
}

/** Chekni canvas'ga chizish. Kenglik 576px (~72mm chop maydoni) — termal printer va Telegram rasmi uchun bir xil. */
export function drawReceipt(r: PrintReceipt, shop: string): HTMLCanvasElement {
  const L = receiptLabels(r)
  const W = 576, pad = 16, innerW = W - pad * 2
  const temp = document.createElement('canvas')
  temp.width = W; temp.height = 5000
  const ctx = temp.getContext('2d')!
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, 5000); ctx.fillStyle = '#000'
  let y = pad
  const FN = "-apple-system,'Segoe UI',Arial,sans-serif"
  const center = (t: string, size: number, bold = false) => {
    ctx.font = `${bold ? '700 ' : ''}${size}px ${FN}`; ctx.textAlign = 'center'
    ctx.fillText(t, W / 2, y + size); y += size + 6
  }
  const lr = (l: string, rt: string, size: number, bold = false) => {
    ctx.font = `${bold ? '700 ' : ''}${size}px ${FN}`
    ctx.textAlign = 'left'; ctx.fillText(l, pad, y + size)
    ctx.textAlign = 'right'; ctx.fillText(rt, W - pad, y + size); y += size + 8
  }
  const hr = (dashed = true) => {
    y += 4; ctx.beginPath(); ctx.lineWidth = dashed ? 1 : 2
    if (dashed) ctx.setLineDash([5, 5]); else ctx.setLineDash([])
    ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke(); ctx.setLineDash([]); y += 10
  }

  center(shop, 30, true)
  center(`${L.title} #${r.receipt_number}`, 20)
  if (L.original) center(L.original, 18)
  center(`${formatDateTime(r.created_at)} · ${r.customer}`, 18)
  hr()
  for (const it of r.items) {
    ctx.font = `22px ${FN}`; ctx.textAlign = 'left'
    for (const ln of wrapText(ctx, it.name, innerW)) { ctx.fillText(ln, pad, y + 22); y += 28 }
    lr(`${it.qty} ${it.unit} × ${moneySum(it.price)}`, moneySum(it.subtotal), 20)
    y += 2
  }
  hr()
  if (r.discount > 0) lr(t('print.discount'), '− ' + moneySum(r.discount), 20)
  lr(L.total, moneySum(r.total), 28, true)
  if (r.paid_cash > 0) lr(L.cash, moneySum(r.paid_cash), 20)
  if (r.paid_card > 0) lr(L.card, moneySum(r.paid_card), 20)
  if (r.change > 0) lr(t('print.change'), moneySum(r.change), 20)
  if (r.debt > 0) lr(L.debt, moneySum(r.debt), 22, true)
  if (r.balance_before !== undefined) lr(t('print.balanceBefore'), balanceText(r.balance_before), 20)
  if (r.balance_after !== undefined) lr(t('print.balanceAfter'), balanceText(r.balance_after), 22, true)
  hr(false)
  if (L.foot) center(L.foot, 18)
  y += pad

  const out = document.createElement('canvas')
  out.width = W; out.height = Math.ceil(y)
  out.getContext('2d')!.drawImage(temp, 0, 0)
  return out
}

