import { requireOptionalNativeModule } from 'expo-modules-core';

interface NoxCrypto {
  /** Android only: iOS checks signatures in JavaScript for now. */
  verifySchnorr?(signature: string, message: string, pubkey: string): boolean;
  sha256Hex(text: string): string;
}

/** Null where the native side does not exist. */
export default requireOptionalNativeModule<NoxCrypto>('NoxCrypto');
