//! Kameraga OS darajasidagi ruxsat (macOS TCC).
//!
//! WebView ichidagi getUserMedia faqat "ruxsat yo'q" deydi: ruxsat hali so'ralmaganmi
//! yoki foydalanuvchi rad etganmi — farqlab bo'lmaydi, macOS esa rad etilgandan keyin
//! qayta so'ramaydi. Shu sabab holatni AVFoundation'dan o'zimiz o'qiymiz: so'ralmagan
//! bo'lsa tizim oynasini ochamiz, rad etilgan bo'lsa UI Tizim sozlamalariga yuboradi.
//! Boshqa platformalarda holat `Unknown` — UI to'g'ridan getUserMedia'ga tayanadi.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CameraPermission {
    Granted,
    Denied,
    Restricted,
    Prompt,
    Unknown,
}

/// AVAuthorizationStatus → holat (0 notDetermined, 1 restricted, 2 denied, 3 authorized).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn from_av_status(raw: isize) -> CameraPermission {
    match raw {
        0 => CameraPermission::Prompt,
        1 => CameraPermission::Restricted,
        2 => CameraPermission::Denied,
        3 => CameraPermission::Granted,
        _ => CameraPermission::Unknown,
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{from_av_status, CameraPermission};
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use std::sync::{mpsc, Mutex};

    // Framework aniq ulanadi: aks holda AVCaptureDevice klassi jarayonda bo'lmasligi mumkin.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeVideo: Option<&'static AnyObject>;
    }

    fn device_and_media() -> Option<(&'static AnyClass, &'static AnyObject)> {
        let cls = AnyClass::get(c"AVCaptureDevice")?;
        // SAFETY: AVFoundation eksport qiladigan o'zgarmas NSString konstanta.
        let media = unsafe { AVMediaTypeVideo }?;
        Some((cls, media))
    }

    pub fn status() -> CameraPermission {
        let Some((cls, media)) = device_and_media() else {
            return CameraPermission::Unknown;
        };
        // SAFETY: +[AVCaptureDevice authorizationStatusForMediaType:] → NSInteger.
        let raw: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: media] };
        from_av_status(raw)
    }

    /// Tizim so'rov oynasini ochadi. Javob completion handler orqali (ixtiyoriy oqimda) keladi.
    pub fn request() -> Option<mpsc::Receiver<bool>> {
        let (cls, media) = device_and_media()?;
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(Some(tx));
        let handler = RcBlock::new(move |granted: Bool| {
            if let Some(tx) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = tx.send(granted.as_bool());
            }
        });
        // SAFETY: +[AVCaptureDevice requestAccessForMediaType:completionHandler:] blokni o'zi nusxalaydi.
        unsafe {
            let _: () = msg_send![cls, requestAccessForMediaType: media, completionHandler: &*handler];
        }
        Some(rx)
    }
}

#[cfg(target_os = "macos")]
fn platform_status() -> CameraPermission {
    mac::status()
}

#[cfg(not(target_os = "macos"))]
fn platform_status() -> CameraPermission {
    CameraPermission::Unknown
}

/// Foydalanuvchi tizim oynasida o'ylab qolishi mumkin — shuncha kutamiz, keyin holatni qayta o'qiymiz.
#[cfg(target_os = "macos")]
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

#[cfg(target_os = "macos")]
async fn platform_request() -> CameraPermission {
    let current = mac::status();
    if current != CameraPermission::Prompt {
        return current;
    }
    let Some(rx) = mac::request() else {
        return CameraPermission::Unknown;
    };
    // Kutish blocking pool'da — main thread (UI) bo'sh qoladi (lib.rs qoidasi).
    let answer = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(REQUEST_TIMEOUT)).await;
    match answer {
        Ok(Ok(true)) => CameraPermission::Granted,
        Ok(Ok(false)) => CameraPermission::Denied,
        _ => mac::status(),
    }
}

#[cfg(not(target_os = "macos"))]
async fn platform_request() -> CameraPermission {
    CameraPermission::Unknown
}

#[tauri::command]
pub async fn camera_permission() -> CameraPermission {
    platform_status()
}

/// Holat `Prompt` bo'lsa tizim oynasini ochadi va javobni qaytaradi; aks holda joriy holat.
#[tauri::command]
pub async fn request_camera_permission() -> CameraPermission {
    let result = platform_request().await;
    log::info!("kamera ruxsati: {result:?}");
    result
}

/// Rad etilgan ruxsatni dastur qayta so'ray olmaydi — Tizim sozlamalarining Kamera bo'limini ochamiz.
#[tauri::command]
pub async fn open_camera_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
        .spawn();
    #[cfg(target_os = "windows")]
    let spawned = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:privacy-webcam")
            .creation_flags(crate::CREATE_NO_WINDOW)
            .spawn()
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let spawned: std::io::Result<std::process::Child> =
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "unsupported"));
    spawned
        .map(|_| ())
        .map_err(|e| format!("Sozlamalar ochilmadi: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn av_status_maps_to_permission() {
        assert_eq!(from_av_status(0), CameraPermission::Prompt);
        assert_eq!(from_av_status(1), CameraPermission::Restricted);
        assert_eq!(from_av_status(2), CameraPermission::Denied);
        assert_eq!(from_av_status(3), CameraPermission::Granted);
        assert_eq!(from_av_status(42), CameraPermission::Unknown);
    }

    #[test]
    fn permission_serializes_lowercase_for_ui() {
        assert_eq!(serde_json::to_value(CameraPermission::Prompt).unwrap(), "prompt");
        assert_eq!(serde_json::to_value(CameraPermission::Granted).unwrap(), "granted");
    }

    // Haqiqiy AVFoundation chaqiruvi yiqilmasligi (klass topiladi, holat o'qiladi).
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_status_query_does_not_crash() {
        assert_ne!(mac::status(), CameraPermission::Unknown);
    }
}
