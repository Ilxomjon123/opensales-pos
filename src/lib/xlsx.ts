import { downloadDir, join } from '@tauri-apps/api/path'
import { writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { openPath } from '@tauri-apps/plugin-opener'
import { buildCsv, buildXlsx, safeName, type ExportFormat, type XlsxSheet } from './xlsxBuild'

// Sof builder (fayl tizimisiz) xlsxBuild.ts da — Telegram mini app ham shuni ishlatadi.
export * from './xlsxBuild'

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

export async function saveCsv(baseName: string, sheet: XlsxSheet): Promise<string> {
  const path = await exportPath(baseName, 'csv')
  await writeTextFile(path, buildCsv(sheet))
  try { await openPath(path) } catch (e) { console.error('csv open:', e) }
  return path
}

export function saveSheet(format: ExportFormat, baseName: string, sheet: XlsxSheet): Promise<string> {
  return format === 'csv' ? saveCsv(baseName, sheet) : saveXlsx(baseName, [sheet])
}
