package garden.nox.crypto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import fr.acinq.secp256k1.Hex
import fr.acinq.secp256k1.Secp256k1

/**
 * BIP-340 signatures checked by libsecp256k1. Hermes has no JIT, and the same
 * check in JavaScript takes tens of milliseconds a post.
 */
private val SIG = Regex("^[0-9a-f]{128}$")
private val KEY = Regex("^[0-9a-f]{64}$")

class NoxCryptoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NoxCrypto")

    // Loading the library takes most of a second. Started here, on its own
    // thread, it is done before the first relay answers; on the first check
    // it would stall the JS thread instead.
    OnCreate {
      Thread { Secp256k1.get() }.start()
    }

    // Synchronous: a timeline checks hundreds, and each is well under a millisecond.
    Function("verifySchnorr") { signature: String, message: String, pubkey: String ->
      // Exactly lowercase hex of the right length: Hex.decode also accepts
      // whitespace and a 0x prefix, which nostr-tools refuses.
      if (!SIG.matches(signature) || !KEY.matches(message) || !KEY.matches(pubkey)) {
        return@Function false
      }
      try {
        Secp256k1.verifySchnorr(Hex.decode(signature), Hex.decode(message), Hex.decode(pubkey))
      } catch (e: Exception) {
        false
      }
    }
  }
}
