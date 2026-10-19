import { invoke } from '@tauri-apps/api/core'
import { currentPlatform } from './platform'

// OS darajasidagi kamera ruxsati (Rust camera.rs). macOS'da aniq holat qaytadi;
// boshqa platformalarda 'unknown' — u holda getUserMedia'ning o'z natijasiga tayanamiz.
export type CameraPermission = 'granted' | 'denied' | 'restricted' | 'prompt' | 'unknown'

export async function cameraPermission(): Promise<CameraPermission> {
  try { return await invoke<CameraPermission>('camera_permission') } catch { return 'unknown' }
}

// Hali so'ralmagan bo'lsa tizim oynasini ochadi va foydalanuvchi javobini kutadi.
// Rad etilgan ruxsatni qayta so'rab bo'lmaydi (macOS) — u holda 'denied' qaytadi.
export async function ensureCameraPermission(): Promise<CameraPermission> {
  const s = await cameraPermission()
  if (s !== 'prompt') return s
  try { return await invoke<CameraPermission>('request_camera_permission') } catch { return 'unknown' }
}

// Tizim sozlamalarining Kamera bo'limi faqat desktopda ochiladi.
export const canOpenCameraSettings = currentPlatform === 'macos' || currentPlatform === 'windows'

export async function openCameraSettings(): Promise<void> {
  await invoke('open_camera_settings')
}
