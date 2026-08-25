package garden.nox.client

import android.content.Context
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

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
    applyWindowInsets()
  }

  /**
   * Keeps web content clear of the status bar and the gesture area.
   *
   * Android's WebView reports every `env(safe-area-inset-*)` as 0 even under
   * edge-to-edge, so the CSS that handles this on iOS and the web has nothing
   * to work with here. Padding the content view instead produces the same
   * result without the web layer needing to know.
   */
  private fun applyWindowInsets() {
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val bars = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      view.updatePadding(
        left = bars.left,
        top = bars.top,
        right = bars.right,
        bottom = bars.bottom,
      )
      // Consumed: nothing below should apply these a second time.
      WindowInsetsCompat.CONSUMED
    }
  }
}
