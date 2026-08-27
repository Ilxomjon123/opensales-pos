// Bluetooth printerlarni qidirish — UI hech qachon osilib qolmasligi uchun alohida qatlam.
//
// Nima uchun kerak: Windows'da BLE skan ba'zan javob qaytarmaydi (radio bandi,
// haydovchi/ruxsat muammosi). Ilgari Sozlamalar sahifasi shu va'dani `await`
// qilgani uchun butun sahifa "yuklanmoqda" holatida qotib qolardi. Endi:
//   1) har chaqiruvda qat'iy timeout bor (Rust tomonda ham bor),
//   2) bir vaqtda faqat bitta skan ketadi,
//   3) topilgan qurilmalar sessiya davomida keshda — sahifaga har kirganda
//      radio qayta skanerlanmaydi.
import { invoke } from '@tauri-apps/api/core'

export type BleDevice = { id: string; name: string }

const SCAN_TIMEOUT_MS = 20000

let cache: BleDevice[] = []
let scanning = false
let scannedOnce = false

export function cachedBleDevices(): BleDevice[] {
  return [...cache]
}

export function bleScannedOnce(): boolean {
  return scannedOnce
}

// Saqlangan (tanlangan) printerni ro'yxatda ushlab turish uchun.
export function rememberBleDevice(d: BleDevice) {
  if (!cache.some((x) => x.id === d.id)) cache.push(d)
}

export function isBleScanning(): boolean {
  return scanning
}

export type BleScanResult = { devices: BleDevice[]; error: string }

export async function scanBlePrinters(): Promise<BleScanResult> {
  if (scanning) return { devices: cachedBleDevices(), error: '' }
  scanning = true
  try {
    const found = await withTimeout(invoke<BleDevice[]>('scan_bluetooth_printers'), SCAN_TIMEOUT_MS)
    if (found.timedOut) return { devices: cachedBleDevices(), error: 'timeout' }
    if (found.error) return { devices: cachedBleDevices(), error: String(found.error) }
    // Skanda topilganlar + eski (tanlangan) qurilmalar.
    const merged = [...(found.value ?? [])]
    for (const d of cache) if (!merged.some((x) => x.id === d.id)) merged.push(d)
    cache = merged
    return { devices: cachedBleDevices(), error: '' }
  } finally {
    scanning = false
    scannedOnce = true
  }
}

type Settled<T> = { value?: T; error?: unknown; timedOut: boolean }

// Va'da berilgan vaqtda tugamasa kutishni to'xtatadi. Rust tomondagi ish davom
// etishi mumkin, lekin UI bloklanmaydi.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise<Settled<T>>((resolve) => {
    let done = false
    const finish = (r: Settled<T>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => finish({ timedOut: true }), ms)
    p.then((v) => finish({ value: v, timedOut: false })).catch((e) => finish({ error: e ?? new Error('scan failed'), timedOut: false }))
  })
}
