package garden.nox.client

import android.content.Context
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  /**
   * Hands the application context to the Rust keyring backend.
   *
   * Implemented in `src-tauri/src/secret_store.rs`. Tauri does not populate
   * `ndk_context` itself, and the backend panics without it, so this has to run
   * before any secret command reaches Rust.
   */
  private external fun initNdkContext(context: Context)

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // super.onCreate loads the Rust library, so the native method above is only
    // resolvable afterwards.
    super.onCreate(savedInstanceState)
    initNdkContext(applicationContext)
  }
}
