// Shtrix/2D kod yaratish va chizish (bwip-js — hamma simbologiya). Offline.
import bwipjs from 'bwip-js/browser'
import { findProductByBarcode } from './db'

// ZXing format nomi -> bwip-js bcid. Skan qilingan tur shu nom bilan saqlanadi.
const BCID: Record<string, string> = {
  QR_CODE: 'qrcode',
  DATA_MATRIX: 'datamatrix',
  AZTEC: 'azteccode',
  PDF_417: 'pdf417',
  EAN_13: 'ean13',
  EAN_8: 'ean8',
  UPC_A: 'upca',
  UPC_E: 'upce',
  CODE_128: 'code128',
  CODE_39: 'code39',
  ITF: 'interleaved2of5',
}

const TWO_D = new Set(['qrcode', 'datamatrix', 'azteccode', 'pdf417'])

// EAN-13 nazorat raqami (checksum).
function ean13Checksum(d12: string): string {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3)
  return String((10 - (sum % 10)) % 10)
}

// Ichki EAN-13 yaratish. '20' prefiks = do'kon ichki kodlari uchun ajratilgan diapazon.
export function genEan13(): string {
  let base = '20'
  for (let i = 0; i < 10; i++) base += Math.floor(Math.random() * 10)
  return base + ean13Checksum(base)
}

// Bazaда mavjud bo'lmagan noyob kod.
export async function generateUniqueBarcode(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const c = genEan13()
    if (!(await findProductByBarcode(c))) return c
  }
  return genEan13()
}

// Kod tarkibига qarab format taxmin qilish (tur saqlanmagan eski yozuvlar uchun).
function autoBcid(code: string): string {
  if (/^\d{13}$/.test(code)) return 'ean13'
  if (/^\d{12}$/.test(code)) return 'upca'
  if (/^\d{8}$/.test(code)) return 'ean8'
  return 'code128'
}

// Saqlangan tur (ZXing nomi) bo'lsa o'shани, bo'lmasa auto.
function bcidFor(code: string, type?: string | null): string {
  if (type && type !== 'AUTO' && BCID[type]) return BCID[type]
  return autoBcid(code)
}

export type RenderOpts = { scale?: number; includetext?: boolean }

// Kodни canvasga chizadi (saqlangan formatда). Yaroqsiz bo'lsa code128'га, u ham bo'lmasa null.
export function renderBarcodeCanvas(code: string, type?: string | null, opts: RenderOpts = {}): HTMLCanvasElement | null {
  const c = code.trim()
  if (!c) return null
  const bcid = bcidFor(c, type)
  // Chiziqни TOZA chizamiz (bwip raqamисиз). Raqamни o'zимиз pastга alohida yozamiz —
  // shunda EAN guard chiziqlari raqам ustiga tushmaydi.
  const bc = document.createElement('canvas')
  const base: any = { bcid, text: c, scale: opts.scale ?? 3, includetext: false, paddingwidth: 1, paddingheight: 1 }
  if (!TWO_D.has(bcid)) base.height = 12
  try { bwipjs.toCanvas(bc, base) }
  catch {
    try { bwipjs.toCanvas(bc, { bcid: 'code128', text: c, scale: opts.scale ?? 3, height: 12, includetext: false }) }
    catch { return null }
  }

  // 1D — raqamни pastга yozamiz (do'kon standartи). 2D (QR/DataMatrix) — yo'q.
  const showNum = opts.includetext ?? !TWO_D.has(bcid)
  if (!showNum) return bc

  const font = Math.max(14, Math.round(bc.width * 0.085))
  const gap = Math.round(font * 0.35)
  const out = document.createElement('canvas')
  out.width = bc.width
  out.height = bc.height + gap + font + Math.round(font * 0.3)
  const ctx = out.getContext('2d')!
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(bc, 0, 0)
  ctx.fillStyle = '#000'
  ctx.font = `700 ${font}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(c, out.width / 2, bc.height + gap)
  return out
}

// Ko'rish (preview) uchun data URL.
export function barcodeDataUrl(code: string, type?: string | null, opts: RenderOpts = {}): string {
  const cv = renderBarcodeCanvas(code, type, opts)
  return cv ? cv.toDataURL('image/png') : ''
}
