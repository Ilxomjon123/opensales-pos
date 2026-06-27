// Browsersiz pechat — PNG'ni Rust backend orqali to'g'ridan printerга yuborish.
import { invoke } from '@tauri-apps/api/core'
import { writeFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs'
import { appCacheDir, join } from '@tauri-apps/api/path'

// Tizimда o'rnatilган printerlar.
export function listPrinters(): Promise<string[]> {
  return invoke<string[]>('list_printers').catch(() => [])
}

// PNG baytlarini faylга yozib, printerга yuboradi. printer bo'sh = standart printer.
export async function printPng(bytes: Uint8Array, opts: { printer?: string; copies?: number; name?: string } = {}): Promise<void> {
  await mkdir('print', { baseDir: BaseDirectory.AppCache, recursive: true }).catch(() => {})
  const rel = `print/${(opts.name || 'out').replace(/[^0-9a-z-]/gi, '')}.png`
  await writeFile(rel, bytes, { baseDir: BaseDirectory.AppCache })
  const full = await join(await appCacheDir(), rel)
  await invoke('print_file', { path: full, printer: opts.printer || null, copies: opts.copies ?? 1 })
}

// SVG matnини <img> ga aylantirish (canvasга chizish uchun).
export function svgToImage(svg: string): Promise<HTMLImageElement> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
    img.src = url
  })
}

// Canvas → PNG baytlar.
export function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => {
      if (!b) { reject(new Error('PNG yaratilmadi')); return }
      b.arrayBuffer().then((a) => resolve(new Uint8Array(a)))
    }, 'image/png')
  })
}
