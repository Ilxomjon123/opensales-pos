import { api, RpcError } from '../rpc'
import { session } from '../session'
import { atLeast, haptic, openTelegramLink, repaintAfterOverlay, tg } from '../telegram'
import { moneySum, formatDateTime } from '../../../src/lib/format'
import { notify } from '../../../src/lib/notify'
import { t } from './i18n'
import type { PrintReceipt, PrintLabel } from '../../../src/lib/print'
import { balanceText, drawReceipt } from '../../../src/lib/receiptCanvas'

// Desktop print.ts (printer, BLE, PNG) o'rniga: Telegram webview'da printer yo'q. Chek ULASHILADI:
// server chiroyli HTML xabar tayyorlaydi (savePreparedInlineMessage), Telegram chat tanlash oynasi
// ochiladi — xodim mijozga/guruhga yuboradi (o'ziga EMAS). Eski Telegram'da — t.me/share (oddiy matn).
export type { PrintReceipt, PrintLabel }

export function receiptText(r: PrintReceipt): string {
  const ret = r.kind === 'return'
  const shop = r.shop ?? session.settings.shop_name ?? session.shop?.name ?? 'OpenSales'
  const lines: string[] = [shop, `${ret ? t('print.returnReceipt') : t('print.receipt')} #${r.receipt_number}`]
  if (ret && r.original_receipt) lines.push(`${t('print.originalReceipt')} #${r.original_receipt}`)
  lines.push(`${formatDateTime(r.created_at)} · ${r.customer}`, '')
  for (const it of r.items) lines.push(`${it.name}`, `  ${it.qty} ${it.unit} × ${moneySum(it.price)} = ${moneySum(it.subtotal)}`)
  lines.push('')
  if (r.discount > 0) lines.push(`${t('print.discount')}: −${moneySum(r.discount)}`)
  lines.push(`${ret ? t('print.refundTotal') : t('print.total')}: ${moneySum(r.total)}`)
  if (r.paid_cash > 0) lines.push(`${ret ? t('print.refundCash') : t('print.cash')}: ${moneySum(r.paid_cash)}`)
  if (r.paid_card > 0) lines.push(`${ret ? t('print.refundCard') : t('print.card')}: ${moneySum(r.paid_card)}`)
  if (r.change > 0) lines.push(`${t('print.change')}: ${moneySum(r.change)}`)
  if (r.debt > 0) lines.push(`${ret ? t('print.refundBalance') : t('print.debt')}: ${moneySum(r.debt)}`)
  if (r.balance_before !== undefined) lines.push(`${t('print.balanceBefore')}: ${balanceText(r.balance_before)}`)
  if (r.balance_after !== undefined) lines.push(`${t('print.balanceAfter')}: ${balanceText(r.balance_after)}`)
  if (!ret) lines.push('', t('print.thankYou'))
  return lines.join('\n')
}

/** Server chek kartasi (receiptCard.ts): tayyor, formatlangan, tarjima qilingan satrlar — server escape qiladi. */
function receiptCard(r: PrintReceipt) {
  const ret = r.kind === 'return'
  const rows: { kind: string; label: string; value: string }[] = []
  if (r.discount > 0) rows.push({ kind: 'discount', label: t('print.discount'), value: `−${moneySum(r.discount)}` })
  if (r.paid_cash > 0) rows.push({ kind: 'cash', label: ret ? t('print.refundCash') : t('print.cash'), value: moneySum(r.paid_cash) })
  if (r.paid_card > 0) rows.push({ kind: 'card', label: ret ? t('print.refundCard') : t('print.card'), value: moneySum(r.paid_card) })
  if (r.change > 0) rows.push({ kind: 'change', label: t('print.change'), value: moneySum(r.change) })
  if (r.debt > 0) rows.push({ kind: ret ? 'balance' : 'debt', label: ret ? t('print.refundBalance') : t('print.debt'), value: moneySum(r.debt) })
  if (r.balance_before !== undefined) rows.push({ kind: 'balance', label: t('print.balanceBefore'), value: balanceText(r.balance_before) })
  if (r.balance_after !== undefined) rows.push({ kind: 'balance', label: t('print.balanceAfter'), value: balanceText(r.balance_after) })
  const meta = [formatDateTime(r.created_at), r.customer, ret && r.original_receipt ? `${t('print.originalReceipt')} #${r.original_receipt}` : '']
  return {
    shop: r.shop ?? session.settings.shop_name ?? session.shop?.name ?? 'OpenSales',
    title: `${ret ? t('print.returnReceipt') : t('print.receipt')} #${r.receipt_number}`,
    meta: meta.filter(Boolean).join(' · '),
    items: r.items.map((it) => ({ name: it.name, line: `${it.qty} ${it.unit} × ${moneySum(it.price)}`, sum: moneySum(it.subtotal) })),
    total: { label: ret ? t('print.refundTotal') : t('print.total'), value: moneySum(r.total) },
    rows,
    foot: ret ? null : t('print.thankYou'),
  }
}

/** Oddiy matnni ulashish (eski Telegram yoki tayyor xabar ishlamasa). */
function shareText(text: string) {
  if (tg) { openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(text)}`); return }
  if (navigator.share) { void navigator.share({ text }).catch(() => {}); return }
  void navigator.clipboard?.writeText(text).then(() => notify(t('cloud.staff.copied'), 'success'))
}

/** Chek rasmi (JPEG, base64) — desktop termal chek bilan bir xil chizilgan (receiptCanvas.ts). */
async function receiptJpeg(r: PrintReceipt): Promise<string | null> {
  try {
    const canvas = drawReceipt(r, r.shop ?? session.settings.shop_name ?? session.shop?.name ?? 'OpenSales')
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.9))
    if (!blob) return null
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  } catch {
    return null
  }
}

export async function printReceipt(r: PrintReceipt) {
  if (tg?.shareMessage && atLeast('8.0')) {
    try {
      // Rasm + matn (rasm yasalmasa — faqat matn).
      const { id } = await api<{ id: string }>('/api/receipt', { card: receiptCard(r), image: await receiptJpeg(r) })
      tg.shareMessage(id, (sent) => {
        repaintAfterOverlay()
        if (sent) { haptic('success'); notify(t('cloud.receiptShared'), 'success') }
      })
      return
    } catch (e) {
      // Tayyor xabar yaratilmadi (tarmoq/bot sozlamasi) — oddiy matn bilan ulashamiz.
      if (e instanceof RpcError && e.code !== 'cloud.errors.telegramFailed') { notify(t(e.code, e.params), 'error'); return }
    }
  }
  shareText(receiptText(r))
}

export async function printLabel(_l: PrintLabel) {
  notify(t('cloud.labelUnavailable'), 'info')
}

export async function printReceiptBluetooth(): Promise<void> { throw new Error('Bluetooth printing is not available in Telegram') }
export async function printLabelBluetooth(): Promise<void> { throw new Error('Bluetooth printing is not available in Telegram') }
