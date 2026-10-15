import { requireOptionalNativeModule } from 'expo-modules-core';

interface NoxCrypto {
  verifySchnorr(signature: string, message: string, pubkey: string): boolean;
  sha256Hex(text: string): string;
}

/** Null where the native side does not exist (iOS, for now). */
export default requireOptionalNativeModule<NoxCrypto>('NoxCrypto');
