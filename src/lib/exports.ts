import { t } from './i18n'
import { formatDateTime } from './format'
import { colName, firstDataRow, saveSheet, saveXlsx, type ExportFormat, type XlsxSheet } from './xlsx'
import type { Product } from './db'
import type { MovementRow, MoveSummary, ProductMove } from './stock'

// Excel/CSV eksportlari. Har biri Downloads'ga yozib, darhol ochadi (lib/xlsx.ts).

const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + (f(x) || 0), 0)
const q3 = (n: number) => Math.round(n * 1000) / 1000
// YYYY-MM-DD → DD.MM.YYYY (sarlavha uchun).
const day = (iso: string) => iso.split('-').reverse().join('.')

// Mahsulotlar + qoldiq. Oxirgi ikki ustun inventarizatsiya uchun: "Sanaldi" ga qo'lda
// sanalgan son yoziladi, "Farq" o'zi hisoblanadi (bo'sh bo'lsa bo'sh qoladi).
export async function exportProducts(products: Product[], categoryName: (id: number | null) => string): Promise<string> {
  const QTY = 5 // "Qoldiq" ustuni indeksi (0 dan)
  const COUNTED = 10
  const title = t('exports.productsTitle', { date: formatDateTime(new Date().toISOString()) })
  const FIRST_ROW = firstDataRow({ title })
  const sheet: XlsxSheet = {
    name: t('exports.productsSheet'),
    title,
    columns: [
      { header: '№', width: 6, type: 'number' },
      { header: t('exports.colName'), width: 36 },
      { header: t('exports.colCategory'), width: 18 },
      { header: t('exports.colBarcode'), width: 16 },
      { header: t('exports.colUnit'), width: 8 },
      { header: t('exports.colStock'), width: 11, type: 'number' },
      { header: t('exports.colCost'), width: 13, type: 'money' },
      { header: t('exports.colPrice'), width: 13, type: 'money' },
      { header: t('exports.colStockCost'), width: 16, type: 'money' },
      { header: t('exports.colStockValue'), width: 16, type: 'money' },
      { header: t('exports.colCounted'), width: 11, type: 'number' },
      { header: t('exports.colDiff'), width: 10, type: 'number' },
    ],
    rows: products.map((p, i) => {
      const r = FIRST_ROW + i
      const counted = `${colName(COUNTED)}${r}`
      return [
        i + 1, p.name, categoryName(p.category_id), p.barcode ?? '', p.unit, q3(p.stock),
        Math.round(p.cost_price), Math.round(p.price),
        Math.round(p.cost_price * p.stock), Math.round(p.price * p.stock),
        null, { f: `IF(${counted}="","",${counted}-${colName(QTY)}${r})` },
      ]
    }),
    // Qoldiq soni jamlanmaydi — dona va kg ni qo'shib bo'lmaydi.
    totals: [
      null, t('exports.total', { count: products.length }), null, null, null, null, null, null,
      Math.round(sum(products, (p) => p.cost_price * p.stock)), Math.round(sum(products, (p) => p.price * p.stock)),
    ],
  }
  return saveXlsx(t('exports.productsFile'), [sheet])
}

// Davr harakati — ekrandagi qatorlar (qidiruv qo'llangan).
export async function exportMovement(format: ExportFormat, rows: MovementRow[], dateFrom: string, dateTo: string): Promise<string> {
  const sheet: XlsxSheet = {
    name: t('exports.movementSheet'),
    title: t('exports.movementTitle', { from: day(dateFrom), to: day(dateTo) }),
    meta: [[t('exports.metaExported'), formatDateTime(new Date().toISOString())]],
    columns: [
      { header: t('exports.colName'), width: 36 },
      { header: t('exports.colCategory'), width: 18 },
      { header: t('exports.colUnit'), width: 8 },
      { header: t('exports.colOpening'), width: 13, type: 'number' },
      { header: t('exports.colIn'), width: 11, type: 'number' },
      { header: t('exports.colOut'), width: 11, type: 'number' },
      { header: t('exports.colClosing'), width: 13, type: 'number' },
      { header: t('exports.colClosingCost'), width: 16, type: 'money' },
    ],
    rows: rows.map((r) => [r.name, r.category ?? '', r.unit, r.opening, r.income, r.outcome, r.closing, Math.round(r.closing * r.cost_price)]),
    totals: [t('exports.total', { count: rows.length }), null, null, null, null, null, null, Math.round(sum(rows, (r) => r.closing * r.cost_price))],
  }
  return saveSheet(format, t('exports.movementFile', { from: dateFrom, to: dateTo }), sheet)
}

export type ProductMovesExport = {
  product: { id: number; name: string; unit: string; barcode: string | null }
  from: string
  to: string
  summary: MoveSummary
  /** Ekrandagi filtr va tartib qo'llangan qatorlar. */
  rows: ProductMove[]
  kindLabel: (m: ProductMove) => string
  /** Filtr matnlari (bo'sh bo'lsa meta'ga yozilmaydi). */
  filter: { direction?: string; party?: string; search?: string }
}

// Mahsulot harakati — Panda kartochkasi eksporti: tepada mahsulot, davr va yig'indilar,
// ostida hujjatlar (ekrandagi filtr va tartibda), har biridan keyingi qoldiq bilan.
export async function exportProductMoves(format: ExportFormat, x: ProductMovesExport): Promise<string> {
  const u = ` ${x.product.unit}`
  const meta: [string, string][] = [
    [t('exports.metaProduct'), [x.product.barcode, x.product.name].filter(Boolean).join(' ')],
    [t('exports.metaUnit'), x.product.unit],
    [t('exports.metaPeriod'), `${day(x.from)} — ${day(x.to)}`],
    [t('exports.metaOpening'), x.summary.opening + u],
    [t('exports.metaIn'), x.summary.income + u],
    [t('exports.metaOut'), x.summary.outcome + u],
    [t('exports.metaClosing'), x.summary.closing + u],
  ]
  if (x.filter.direction) meta.push([t('exports.metaDirection'), x.filter.direction])
  if (x.filter.party) meta.push([t('exports.metaParty'), x.filter.party])
  if (x.filter.search) meta.push([t('exports.metaSearch'), x.filter.search])
  meta.push([t('exports.metaExported'), formatDateTime(new Date().toISOString())])
  const sheet: XlsxSheet = {
    name: t('exports.productMovesSheet'),
    title: t('exports.productMovesTitle'),
    meta,
    columns: [
      { header: t('exports.colDate'), width: 17 },
      { header: t('exports.colDocument'), width: 16 },
      { header: t('exports.colKind'), width: 11 },
      { header: t('exports.colParty'), width: 28 },
      { header: t('exports.colIn'), width: 10, type: 'number' },
      { header: t('exports.colOut'), width: 10, type: 'number' },
      { header: t('exports.colBalance'), width: 10, type: 'number' },
      { header: t('exports.colPriceSum'), width: 14, type: 'money' },
      { header: t('exports.colAmountSum'), width: 16, type: 'money' },
      { header: t('exports.colNote'), width: 30 },
    ],
    rows: x.rows.map((m) => [
      formatDateTime(m.at), m.number, x.kindLabel(m), m.party ?? '',
      m.delta > 0 ? m.delta : null, m.delta < 0 ? -m.delta : null, m.balance,
      m.price == null ? null : Math.round(m.price), m.amount == null ? null : Math.round(m.amount), m.comment ?? '',
    ]),
  }
  const code = x.product.barcode || String(x.product.id)
  return saveSheet(format, `harakat-${code}-${x.from}_${x.to}`, sheet)
}
