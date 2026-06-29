import { moneySum, formatDateTime } from './format'
import { getSetting } from './db'
import { renderBarcodeCanvas, barcodeDataUrl } from './barcode'
import { printPng, canvasToPng } from './silentprint'
import { writeTextFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs'
import { openPath } from '@tauri-apps/plugin-opener'
import { appCacheDir, join } from '@tauri-apps/api/path'
import { notify } from './notify'
import { t } from './i18n'

export type PrintReceipt = {
  receipt_number: string
  created_at: string
  customer: string
  items: { name: string; qty: number; unit: string; price: number; subtotal: number }[]
  discount: number
  total: number
  paid_cash: number
  paid_card: number
  change: number
  debt: number
  shop?: string
}

export async function printReceipt(r: PrintReceipt) {
  const shop = r.shop ?? (await getSetting('shop_name', 'OpenSales POS'))
  // Browsersiz: chek printeri sozlangan bo'lsa to'g'ridan printerга PNG yuboriladi.
  const printer = (await getSetting('receipt_printer', '')) || (await getSetting('printer_name', ''))
  if (printer) {
    try {
      const png = await receiptPng(r, shop)
      await printPng(png, { printer, name: `chek-${r.receipt_number}` })
      return
    } catch (e: any) {
      notify(t('print.directPrintFailed') + ' ' + (e?.message ?? e), 'error')
      // pastdagi brauzer usuliga tushadi
    }
  }
  const rows = r.items
    .map(
      (it) =>
        `<tr><td>${esc(it.name)}<div class="m">${moneySum(it.price)} /${esc(it.unit)}</div></td><td class="r">${it.qty}</td><td class="r b">${moneySum(it.subtotal)}</td></tr>`,
    )
    .join('')
  const html = `<!doctype html><html><head><meta charset="utf-8">
  <title>${esc(t('print.receipt'))} ${esc(r.receipt_number)}</title>
  <script>window.onload=function(){setTimeout(function(){window.print()},250)}</script>
  <style>
    @media print{@page{margin:4mm}}
    *{font-family:-apple-system,'Segoe UI',sans-serif;box-sizing:border-box}
    body{width:72mm;margin:0 auto;padding:6px;color:#000}
    h2{text-align:center;margin:0;font-size:15px}
    .sub{text-align:center;font-size:11px;color:#444;margin-bottom:6px}
    table{width:100%;border-collapse:collapse;font-size:12px}
    td{padding:3px 0;border-bottom:1px dashed #bbb;vertical-align:top}
    .r{text-align:right;white-space:nowrap}.b{font-weight:600}.m{font-size:10px;color:#666}
    .tot{display:flex;justify-content:space-between;font-weight:700;font-size:14px;margin-top:6px;border-top:1px solid #000;padding-top:6px}
    .line{display:flex;justify-content:space-between;font-size:12px}
    .foot{text-align:center;font-size:11px;color:#444;margin-top:8px}
  </style></head><body>
    <h2>${esc(shop)}</h2>
    <div class="sub">${esc(t('print.receipt'))} #${esc(r.receipt_number)}<br>${formatDateTime(r.created_at)} · ${esc(r.customer)}</div>
    <table>${rows}</table>
    ${r.discount > 0 ? line(esc(t('print.discount')), '− ' + moneySum(r.discount)) : ''}
    <div class="tot"><span>${esc(t('print.total'))}</span><span>${moneySum(r.total)}</span></div>
    ${r.paid_cash > 0 ? line(esc(t('print.cash')), moneySum(r.paid_cash)) : ''}
    ${r.paid_card > 0 ? line(esc(t('print.card')), moneySum(r.paid_card)) : ''}
    ${r.change > 0 ? line(esc(t('print.change')), moneySum(r.change)) : ''}
    ${r.debt > 0 ? line(esc(t('print.debt')), moneySum(r.debt)) : ''}
    <div class="foot">${esc(t('print.thankYou'))}</div>
  </body></html>`

  // Tauri WKWebView window.print() macOS'da ishlamaydi — chekni HTML'ga yozib,
  // tizim brauzerida ochamiz (u yerda auto-print ishlaydi).
  try {
    await mkdir('receipts', { baseDir: BaseDirectory.AppCache, recursive: true }).catch(() => {})
    const rel = `receipts/chek-${r.receipt_number.replace(/[^0-9a-z-]/gi, '')}.html`
    await writeTextFile(rel, html, { baseDir: BaseDirectory.AppCache })
    const full = await join(await appCacheDir(), rel)
    await openPath(full)
  } catch (e: any) {
    notify(t('print.printError') + ' ' + (e?.message ?? e), 'error')
  }
}

// --- Mahsulot yorlig'i (nakleyka printer) ---
// Bitta yorliqда: nom, shtrix kod (raqami bilan), narx. `copies` nusxa soni.
// Yorliq o'lchami `size` (mm), default 40×30. 58mm rulonли printer uchun '58mm 40mm' bering.
// type: skan qilingan simbologiya (QR_CODE/DATA_MATRIX/EAN_13...) — yorliq AYNAN shu turда chiqadi.
export type PrintLabel = { name: string; price: number; barcode: string; type?: string | null; copies?: number; size?: string; currency?: string; showPrice?: boolean }

export async function printLabel(l: PrintLabel) {
  const dataUrl = barcodeDataUrl(l.barcode, l.type, { scale: 4 })
  if (!dataUrl) { notify(t('print.invalidCode'), 'error'); return }
  const size = l.size ?? '40mm 30mm'
  const copies = Math.max(1, Math.min(100, l.copies || 1))
  const showPrice = l.showPrice !== false

  // Browsersiz: yorliq printeri sozlangan bo'lsa to'g'ridan printerга PNG yuboriladi.
  const printer = (await getSetting('label_printer', '')) || (await getSetting('printer_name', ''))
  if (printer) {
    try {
      const png = await labelPng(l, size, showPrice)
      await printPng(png, { printer, copies, name: `yorliq-${l.barcode}` })
      return
    } catch (e: any) {
      notify(t('print.directPrintFailed') + ' ' + (e?.message ?? e), 'error')
    }
  }
  const one = `<div class="lbl">
    <div class="nm">${esc(l.name)}</div>
    <div class="bc"><img src="${dataUrl}"></div>
    ${showPrice ? `<div class="pr">${esc(moneySum(l.price))}</div>` : ''}
  </div>`
  const labels = Array.from({ length: copies }, () => one).join('')
  const html = `<!doctype html><html><head><meta charset="utf-8">
  <title>${esc(t('print.label'))}</title>
  <script>window.onload=function(){setTimeout(function(){window.print()},250)}</script>
  <style>
    @page{size:${size};margin:0}
    *{font-family:-apple-system,'Segoe UI',sans-serif;box-sizing:border-box;margin:0;padding:0}
    body{color:#000}
    .lbl{width:${size.split(' ')[0]};height:${size.split(' ')[1] || 'auto'};padding:1.5mm;display:flex;flex-direction:column;align-items:center;justify-content:space-between;page-break-after:always;overflow:hidden}
    .lbl:last-child{page-break-after:auto}
    .nm{font-size:10px;font-weight:600;text-align:center;line-height:1.15;width:100%;flex:0 0 auto;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
    .bc{flex:1 1 auto;min-height:0;width:100%;display:flex;align-items:center;justify-content:center}
    .bc img{max-width:100%;max-height:100%;object-fit:contain}
    .pr{font-size:13px;font-weight:700;flex:0 0 auto}
  </style></head><body>${labels}</body></html>`

  // WKWebView window.print() macOS'да ishlamaydi — HTML'ga yozib tizim brauzerида ochamiz.
  try {
    await mkdir('labels', { baseDir: BaseDirectory.AppCache, recursive: true }).catch(() => {})
    const rel = `labels/yorliq-${l.barcode.replace(/[^0-9a-z-]/gi, '')}.html`
    await writeTextFile(rel, html, { baseDir: BaseDirectory.AppCache })
    const full = await join(await appCacheDir(), rel)
    await openPath(full)
  } catch (e: any) {
    notify(t('print.printError') + ' ' + (e?.message ?? e), 'error')
  }
}

function line(label: string, val: string) {
  return `<div class="line"><span>${label}</span><span>${val}</span></div>`
}
function esc(s: string) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

// ---- Browsersiz pechat uchun rasterlash (canvas → PNG) ----
const DPMM = 8 // ~203dpi termal — 1mm = 8 nuqta

// Matnни kenglikга sig'dirib qatorларга bo'lish. Uzun so'z (probelsiz) ham belgilab kesiladi.
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
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
function clampLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const all = wrapText(ctx, text, maxW)
  if (all.length <= maxLines) return all
  const out = all.slice(0, maxLines)
  let last = out[maxLines - 1]
  while (last.length && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1)
  out[maxLines - 1] = last + '…'
  return out
}

// Chekни PNG'ga chizish. Kenglik 576px (~72mm chop maydoni).
async function receiptPng(r: PrintReceipt, shop: string): Promise<Uint8Array> {
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
  center(`${t('print.receipt')} #${r.receipt_number}`, 20)
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
  lr(t('print.total'), moneySum(r.total), 28, true)
  if (r.paid_cash > 0) lr(t('print.cash'), moneySum(r.paid_cash), 20)
  if (r.paid_card > 0) lr(t('print.card'), moneySum(r.paid_card), 20)
  if (r.change > 0) lr(t('print.change'), moneySum(r.change), 20)
  if (r.debt > 0) lr(t('print.debt'), moneySum(r.debt), 22, true)
  hr(false)
  center(t('print.thankYou'), 18)
  y += pad

  const out = document.createElement('canvas')
  out.width = W; out.height = Math.ceil(y)
  out.getContext('2d')!.drawImage(temp, 0, 0)
  return canvasToPng(out)
}

// Yorliqни PNG'ga chizish (o'lcham mm → nuqta). Nom + shtrix kod + narx.
async function labelPng(l: PrintLabel, size: string, showPrice: boolean): Promise<Uint8Array> {
  const [wm, hm] = size.split(' ')
  const W = Math.round(parseFloat(wm) * DPMM)
  const H = Math.round(parseFloat(hm || '30') * DPMM)
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#000'
  const FN = "-apple-system,'Segoe UI',Arial,sans-serif"
  const pad = Math.round(1.5 * DPMM)

  // Nom (max 2 qator, sig'maса "…")
  const nameSize = Math.round(2.4 * DPMM)
  ctx.font = `600 ${nameSize}px ${FN}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
  const nameLines = clampLines(ctx, l.name || '—', W - pad * 2, 2)
  let y = pad + nameSize
  for (const ln of nameLines) { ctx.fillText(ln, W / 2, y); y += nameSize + 2 }

  // Narx (pastда)
  const priceSize = Math.round(3 * DPMM)
  const priceH = showPrice ? priceSize + 4 : 0
  if (showPrice) {
    ctx.font = `700 ${priceSize}px ${FN}`
    ctx.fillText(moneySum(l.price), W / 2, H - pad)
  }

  // Kod (qolgan bo'sh joyга) — skan qilingan formatда (1D yoki 2D)
  const bc = renderBarcodeCanvas(l.barcode, l.type, { scale: 4 })
  if (bc) {
    const topY = y + 2
    const availH = Math.max(10, H - topY - priceH - pad)
    const availW = W - pad * 2
    const ratio = Math.min(availW / bc.width, availH / bc.height)
    const dw = bc.width * ratio, dh = bc.height * ratio
    ctx.drawImage(bc, (W - dw) / 2, topY + (availH - dh) / 2, dw, dh)
  }
  return canvasToPng(c)
}
