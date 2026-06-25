import { moneySum, formatDateTime } from './format'
import { writeTextFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs'
import { openPath } from '@tauri-apps/plugin-opener'
import { appCacheDir, join } from '@tauri-apps/api/path'
import { notify } from './notify'

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
  const rows = r.items
    .map(
      (it) =>
        `<tr><td>${esc(it.name)}<div class="m">${moneySum(it.price)} /${esc(it.unit)}</div></td><td class="r">${it.qty}</td><td class="r b">${moneySum(it.subtotal)}</td></tr>`,
    )
    .join('')
  const html = `<!doctype html><html><head><meta charset="utf-8">
  <title>Chek ${esc(r.receipt_number)}</title>
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
    <h2>${esc(r.shop ?? 'OpenSales POS')}</h2>
    <div class="sub">Chek #${esc(r.receipt_number)}<br>${formatDateTime(r.created_at)} · ${esc(r.customer)}</div>
    <table>${rows}</table>
    ${r.discount > 0 ? line('Chegirma', '− ' + moneySum(r.discount)) : ''}
    <div class="tot"><span>JAMI</span><span>${moneySum(r.total)}</span></div>
    ${r.paid_cash > 0 ? line('Naqd', moneySum(r.paid_cash)) : ''}
    ${r.paid_card > 0 ? line('Karta', moneySum(r.paid_card)) : ''}
    ${r.change > 0 ? line('Qaytim', moneySum(r.change)) : ''}
    ${r.debt > 0 ? line('Qarz', moneySum(r.debt)) : ''}
    <div class="foot">Xaridingiz uchun rahmat!</div>
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
    notify('Chop etishda xato: ' + (e?.message ?? e), 'error')
  }
}

function line(label: string, val: string) {
  return `<div class="line"><span>${label}</span><span>${val}</span></div>`
}
function esc(s: string) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}
