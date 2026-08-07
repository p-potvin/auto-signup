import { toBase64, fromBase64 } from './pqc';
import { encrypt, decrypt } from './symmetric';
import { generateSalt, saltToBase64, saltFromBase64, deriveKeyFromPin } from './kdf';
import { getKeychain, getCachedMasterKey } from './keychain';
import type { RecoveryKit, EncBlob } from '../types';
import { localStore } from '../platform/store';

/**
 * A recovery kit restores the *account* keys onto a new device or profile.
 *
 * The previous version wrapped a freshly-generated, unrelated KEM keypair, so
 * recovering from it could not decrypt a single existing item. This carries the
 * real account secret keys (encrypted under the master key) plus the master key
 * wrapped under a PIN, which is what actually reopens synced envelopes.
 */

const KIT_VERSION = 2;

export async function generateRecoveryKit(masterKey: Uint8Array, pin: string): Promise<RecoveryKit> {
    const state = await getKeychain();
    if (!state?.kemSecretKeyEnc || !state.sigSecretKeyEnc || !state.kemPublicKey || !state.sigPublicKey) {
        throw new Error('Keychain not initialized');
    }

    const salt = generateSalt();
    const derivedKey = deriveKeyFromPin(pin, salt);
    const { ciphertext, nonce } = encrypt(masterKey, derivedKey);

    return {
        version: KIT_VERSION,
        kemPublicKey: state.kemPublicKey,
        sigPublicKey: state.sigPublicKey,
        // Already encrypted under the master key — copied across as-is.
        kemSecretKeyEnc: state.kemSecretKeyEnc,
        sigSecretKeyEnc: state.sigSecretKeyEnc,
        wrappedMasterKey: { ciphertext: toBase64(ciphertext), nonce: toBase64(nonce) },
        salt: saltToBase64(salt),
        createdAt: new Date().toISOString(),
    };
}

export function exportRecoveryKit(kit: RecoveryKit): string {
    return btoa(JSON.stringify(kit));
}

export function parseRecoveryKit(encoded: string): RecoveryKit {
    const kit = JSON.parse(atob(encoded)) as RecoveryKit;
    if (kit.version !== KIT_VERSION) {
        throw new Error(`Unsupported recovery kit version: ${kit.version}`);
    }
    return kit;
}

/** Unwrap the master key from a kit. Throws if the PIN is wrong. */
export function recoverMasterKey(kit: RecoveryKit, pin: string): Uint8Array {
    const derivedKey = deriveKeyFromPin(pin, saltFromBase64(kit.salt));
    try {
        return decrypt(fromBase64(kit.wrappedMasterKey.ciphertext), fromBase64(kit.wrappedMasterKey.nonce), derivedKey);
    } catch {
        throw new Error('Invalid recovery PIN');
    }
}

/**
 * Restore a kit onto this device: rebuilds the keychain so synced envelopes can
 * be decrypted again. Returns the master key so the caller can unlock.
 */
export async function restoreFromRecoveryKit(kit: RecoveryKit, pin: string): Promise<Uint8Array> {
    const masterKey = recoverMasterKey(kit, pin);

    // Prove the kit's secret keys really open under this master key before
    // overwriting any local state.
    try {
        decrypt(fromBase64(kit.kemSecretKeyEnc.ciphertext), fromBase64(kit.kemSecretKeyEnc.nonce), masterKey);
    } catch {
        throw new Error('Recovery kit is corrupt: account keys do not match the master key');
    }

    const state = {
        kemPublicKey: kit.kemPublicKey,
        sigPublicKey: kit.sigPublicKey,
        kemSecretKeyEnc: kit.kemSecretKeyEnc as EncBlob,
        sigSecretKeyEnc: kit.sigSecretKeyEnc as EncBlob,
        deviceId: null,
    };
    await localStore.set({ vw_keychain: state });

    // Re-wrap the master key under the same PIN for normal unlock on this device.
    const salt = generateSalt();
    const derived = deriveKeyFromPin(pin, salt);
    const wrapped = encrypt(masterKey, derived);
    await localStore.set({
        vw_wrapped_master_key: { ciphertext: toBase64(wrapped.ciphertext), nonce: toBase64(wrapped.nonce) },
        vw_pin_salt: saltToBase64(salt),
    });

    return masterKey;
}

export function downloadRecoveryKit(kit: RecoveryKit): void {
    const encoded = exportRecoveryKit(kit);
    const blob = new Blob([encoded], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vaultwares-recovery-kit-${new Date().toISOString().split('T')[0]}.vwrecovery`;
    a.click();
    URL.revokeObjectURL(url);
}
