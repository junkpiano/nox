import CryptoKit
import ExpoModulesCore

/**
 * Event ids hashed by CryptoKit. Hermes has no JIT, and hashing an event with
 * thousands of tags in JavaScript took tens of milliseconds.
 *
 * Signatures are still checked in JavaScript here: libsecp256k1 is on the
 * Android side only.
 */
public class NoxCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NoxCrypto")

    // An event id: SHA-256 of the serialized event's UTF-8, in lowercase hex.
    Function("sha256Hex") { (text: String) -> String in
      SHA256.hash(data: Data(text.utf8))
        .map { String(format: "%02x", $0) }
        .joined()
    }
  }
}
