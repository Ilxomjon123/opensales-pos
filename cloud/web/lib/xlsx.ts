import { upload, RpcError } from '../rpc'
import { allowBotMessages } from '../session'
import { t } from './i18n'
import { buildCsv, buildXlsx, safeName, type ExportFormat, type XlsxSheet } from '../../../src/lib/xlsxBuild'

// Desktop xlsx.ts (Downloads'ga yozish) o'rniga: fayl Worker orqali xodimning Telegram
// chatiga keladi (sendDocument) — telefonda ochiladi, buxgalterga forward qilinadi.
export * from '../../../src/lib/xlsxBuild'

function stamp(): string {
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`
}

async function send(baseName: string, ext: 'xlsx' | 'csv', bytes: Uint8Array): Promise<string> {
  const name = `${safeName(baseName)}_${stamp()}.${ext}`
  const put = () => upload(`/api/export?name=${encodeURIComponent(name)}`, bytes, ext === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  try {
    try { await put() } catch (e) {
      // Bot unga yoza olmaydi (botni hech ochmagan/bloklagan) — Telegram ruxsat oynasi, berilsa bir marta qayta.
      if (!(e instanceof RpcError && e.code === 'cloud.errors.botBlocked') || !(await allowBotMessages())) throw e
      await put()
    }
  } catch (e) {
    throw e instanceof RpcError ? new Error(t(e.code, e.params)) : e
  }
  return name
}

export function saveXlsx(baseName: string, sheets: XlsxSheet[]): Promise<string> {
  return send(baseName, 'xlsx', buildXlsx(sheets))
}

export function saveCsv(baseName: string, sheet: XlsxSheet): Promise<string> {
  return send(baseName, 'csv', new TextEncoder().encode(buildCsv(sheet)))
}

export function saveSheet(format: ExportFormat, baseName: string, sheet: XlsxSheet): Promise<string> {
  return format === 'csv' ? saveCsv(baseName, sheet) : saveXlsx(baseName, [sheet])
}
