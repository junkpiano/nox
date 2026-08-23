//! Secret storage backed by the platform's native credential store.
//!
//! The Nostr private key must not sit in plaintext once the app ships. Each
//! platform has a native store that encrypts at rest, and `keyring-core`
//! exposes them behind one API:
//!
//! - Android: `SharedPreferences` encrypted with an Android Keystore key
//! - macOS/iOS: Keychain
//! - Windows: Credential Manager
//! - Linux: kernel keyutils
//!
//! No backend requires user authentication, which is deliberate. A key gated on
//! biometrics is invalidated when the user re-enrolls a fingerprint, and an
//! invalidated Nostr key is a permanently lost identity.

use std::sync::OnceLock;

use keyring_core::Entry;

/// Namespace for every credential this app owns.
const SERVICE: &str = "garden.nox.client";

static STORE: OnceLock<Result<(), String>> = OnceLock::new();

fn create_store() -> Result<(), String> {
    #[cfg(target_os = "android")]
    let store = android_native_keyring_store::Store::new();

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let store = apple_native_keyring_store::Store::new();

    #[cfg(target_os = "windows")]
    let store = windows_native_keyring_store::Store::new();

    #[cfg(target_os = "linux")]
    let store = linux_keyutils_keyring_store::Store::new();

    keyring_core::set_default_store(store.map_err(|e| e.to_string())?);
    Ok(())
}

/// Builds the platform store on first use.
///
/// Deferred rather than done during app setup because on Android the backend
/// needs the JNI application context, which `MainActivity` installs only after
/// the Tauri runtime has loaded this library.
///
/// `catch_unwind` is not defensive padding: the Android backend *panics*
/// instead of returning an error when the context is missing, which aborts the
/// process. A keyring that cannot start must degrade to the frontend's storage
/// fallback, never take the app down.
fn ensure_store() -> Result<(), String> {
    STORE
        .get_or_init(|| {
            std::panic::catch_unwind(create_store)
                .unwrap_or_else(|_| Err("keyring backend panicked".to_string()))
        })
        .clone()
}

fn entry(key: &str) -> Result<Entry, String> {
    ensure_store()?;
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_set(key: String, value: Vec<u8>) -> Result<(), String> {
    entry(&key)?.set_secret(&value).map_err(|e| e.to_string())
}

/// Returns `None` when nothing is stored, which is distinct from a backend
/// failure: a first launch must not look like a broken keyring.
#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<Vec<u8>>, String> {
    match entry(&key)?.get_secret() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Deleting an absent credential succeeds, so logout stays idempotent.
#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Installs the JNI application context that the Android keyring backend reads
/// through `ndk_context`.
///
/// Tauri does not populate `ndk_context` itself, and its own
/// `run_on_android_context` sits behind a sealed trait that application code
/// cannot reach, so `MainActivity` calls this directly.
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_garden_nox_client_MainActivity_initNdkContext(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    context: jni::objects::JObject,
) {
    let Ok(vm) = env.get_java_vm() else {
        return;
    };
    let Ok(context) = env.new_global_ref(context) else {
        return;
    };

    unsafe {
        ndk_context::initialize_android_context(
            vm.get_java_vm_pointer().cast(),
            context.as_raw().cast(),
        );
    }

    // ndk_context keeps only the raw pointer, so the global ref has to outlive
    // this call for the lifetime of the process.
    std::mem::forget(context);
}
