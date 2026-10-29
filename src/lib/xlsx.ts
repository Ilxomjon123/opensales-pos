import { zipSync, strToU8 } from 'fflate'
import { downloadDir, join } from '@tauri-apps/api/path'
import { writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { openPath } from '@tauri-apps/plugin-opener'

// Haqiqiy .xlsx (Office Open XML) yozuvchi — CSV emas: rus/o'zbek tilidagi Windows Excel
// CSV'ni ";" bilan kutadi va "," bilan yozilganini bitta ustunga yig'ib qo'yadi.
// Minimal to'plam: inline matn (sharedStrings yo'q), ustun kengligi, sarlavha qatori
// muzlatilgan, pul "#,##0" formatida, formula (Excel ochilganda o'zi hisoblaydi).

export type XlsxColumn = { header: string; width?: number; type?: 'text' | 'number' | 'money' }
export type XlsxCell = string | number | null | undefined | { f: string }
export type XlsxSheet = {
  name: string
  /** Jadval ustidagi sarlavha (masalan, davr). */
  title?: string
  /** Sarlavha ostidagi "nomi: qiymati" qatorlari (mahsulot, davr, filtr...). */
  meta?: [string, string][]
  columns: XlsxColumn[]
  rows: XlsxCell[][]
  /** Pastdagi "Jami" qatori (qalin). */
  totals?: XlsxCell[]
}

// styles.xml dagi cellXfs tartibi.
const S = { text: 0, header: 1, money: 2, moneyBold: 3, bold: 4 } as const

// XML 1.0 da ruxsat etilmagan boshqaruv belgilari olib tashlanadi — aks holda Excel faylni "buzilgan" deydi.
function esc(v: string): string {
  return v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function colName(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

function cell(ref: string, v: XlsxCell, col: XlsxColumn | undefined, bold: boolean): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'object') return `<c r="${ref}"${bold ? ` s="${S.bold}"` : ''}><f>${esc(v.f)}</f></c>`
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return ''
    const s = col?.type === 'money' ? (bold ? S.moneyBold : S.money) : bold ? S.bold : S.text
    return `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`
  }
  const s = bold ? ` s="${S.bold}"` : ''
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${esc(v)}</t></is></c>`
}

function row(r: number, cells: XlsxCell[], columns: XlsxColumn[], style?: 'header' | 'bold'): string {
  const xs = cells.map((v, i) => {
    const ref = `${colName(i)}${r}`
    if (style === 'header') return `<c r="${ref}" t="inlineStr" s="${S.header}"><is><t xml:space="preserve">${esc(String(v ?? ''))}</t></is></c>`
    return cell(ref, v, columns[i], style === 'bold')
  })
  return `<row r="${r}">${xs.join('')}</row>`
}

function sheetXml(sh: XlsxSheet): string {
  const out: string[] = []
  let r = 1
  if (sh.title) out.push(row(r++, [sh.title], [], 'bold'))
  for (const [k, v] of sh.meta ?? []) out.push(row(r++, [k, v], []))
  if (sh.title || sh.meta?.length) r++ // bo'sh qator
  const headerRow = r
  out.push(row(r++, sh.columns.map((c) => c.header), sh.columns, 'header'))
  for (const cells of sh.rows) out.push(row(r++, cells, sh.columns))
  if (sh.totals) out.push(row(r++, sh.totals, sh.columns, 'bold'))
  const cols = sh.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 14}" customWidth="1"/>`)
    .join('')
  const pane = `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>`
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${cols}</cols><sheetData>${out.join('')}</sheetData></worksheet>`
  )
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'

// Excel varaq nomi: ≤31 belgi, []:*?/\ taqiqlangan, takrorlanmasin.
function sheetNames(sheets: XlsxSheet[]): string[] {
  const used = new Set<string>()
  return sheets.map((s, i) => {
    let n = s.name.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`
    while (used.has(n.toLowerCase())) n = `${n.slice(0, 28)} ${i + 1}`
    used.add(n.toLowerCase())
    return n
  })
}

export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error('xlsx: varaq yo\'q')
  const names = sheetNames(sheets)
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        // Formulalarda keshlangan qiymat yo'q — Excel ochilganda hisoblasin.
        '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(STYLES),
  }
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s)) })
  return zipSync(files, { level: 6 })
}

// Birinchi ma'lumot qatorining Excel raqami (1 dan) — formulalar uchun.
export function firstDataRow(sh: Pick<XlsxSheet, 'title' | 'meta'>): number {
  const top = (sh.title ? 1 : 0) + (sh.meta?.length ?? 0)
  return (top ? top + 1 : 0) + 2
}

// Fayl nomi uchun xavfsiz qism (bo'sh joy → "-", OS taqiqlagan belgilar olib tashlanadi).
function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').trim().replace(/\s+/g, '-') || 'export'
}

// Downloads papkasiga yozib, darhol ochadi (Excel/Numbers). Yo'lni qaytaradi.
// Ochib bo'lmasa (dastur yo'q) — fayl baribir saqlangan, xato tashlanmaydi.
async function exportPath(baseName: string, ext: string): Promise<string> {
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  return join(await downloadDir(), `${safeName(baseName)}_${stamp}.${ext}`)
}

export async function saveXlsx(baseName: string, sheets: XlsxSheet[]): Promise<string> {
  const path = await exportPath(baseName, 'xlsx')
  await writeFile(path, buildXlsx(sheets))
  try { await openPath(path) } catch (e) { console.error('xlsx open:', e) }
  return path
}

// CSV — Panda bilan bir xil: UTF-8 BOM (Excel kodlashni taniydi) va ";" (rus/o'zbek
// Windows Excel ro'yxat ajratgichi). Meta va formula yo'q — faqat ustunlar va qatorlar.
export function buildCsv(sh: XlsxSheet): string {
  const cell = (v: XlsxCell): string => {
    if (v === null || v === undefined || typeof v === 'object') return ''
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
    return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  }
  const lines = [sh.columns.map((c) => cell(c.header)), ...sh.rows.map((r) => r.map(cell))]
  if (sh.totals) lines.push(sh.totals.map(cell))
  return '\uFEFF' + lines.map((l) => l.join(';')).join('\r\n') + '\r\n'
}

export async function saveCsv(baseName: string, sheet: XlsxSheet): Promise<string> {
  const path = await exportPath(baseName, 'csv')
  await writeTextFile(path, buildCsv(sheet))
  try { await openPath(path) } catch (e) { console.error('csv open:', e) }
  return path
}

export type ExportFormat = 'xlsx' | 'csv'
export function saveSheet(format: ExportFormat, baseName: string, sheet: XlsxSheet): Promise<string> {
  return format === 'csv' ? saveCsv(baseName, sheet) : saveXlsx(baseName, [sheet])
}
