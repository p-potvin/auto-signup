/**
 * The portable half of the key hierarchy.
 *
 * Before this, the wrapped master key and its salt lived only in local device
 * storage, so they existed on exactly one machine and no second device could
 * ever open the vault. This module moves that material into the shape `vault-warden` already
 * defines at `PUT/GET /v1/account/key`, which is what makes a phone possible.
 *
 *     master password --Argon2id(salt)--> password key
 *     password key --unwraps--> master key           (the "user key")
 *     master key --decrypts--> KEM + signing secret keys
 *     KEM secret --opens--> item envelopes
 *
 * Only the first two lines change hands. The master key is the same random 32
 * bytes it always was, so every existing envelope stays readable and the
 * ML-KEM-768 / ML-DSA-65 layer is untouched — going PWA-only rather than native
 * means `@noble/post-quantum` runs on the phone too, so there is no reason to
 * trade the post-quantum envelope away for portability.
 *
 * What the server sees: KDF parameters, a salt, and ciphertext. The password
 * never leaves the client and the master key is never uploaded unwrapped.
 */

import { argon2id } from '@noble/hashes/argon2';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import { encrypt, decrypt } from './symmetric';
import { toBase64, fromBase64 } from './pqc';
import type { EncBlob, KeychainState } from '../types';

/** Mirrors the `kdf` object vault-warden validates on `PUT /v1/account/key`. */
export interface AccountKdf {
    type: 'argon2id' | 'pbkdf2-sha256';
    iterations: number;
    memory_kib?: number;
    parallelism?: number;
}

export interface AccountKeyBlob {
    kdf: AccountKdf;
    salt_b64: string;
    /** `nonce.ciphertext`, both base64 — the master key under the password key. */
    protected_user_key: string;
}

/**
 * Argon2id at 64 MiB / 3 passes.
 *
 * Matched to the existing local PIN derivation so migrating an install does not
 * silently change the work factor, and chosen to stay tolerable on a phone —
 * this now has to run in mobile Safari, where 64 MiB is near the practical
 * ceiling before the tab risks being reaped.
 */
export const DEFAULT_KDF: AccountKdf = {
    type: 'argon2id',
    iterations: 3,
    memory_kib: 65536,
    parallelism: 1,
};

const SALT_SIZE = 16;
const KEY_SIZE = 32;

/**
 * The minimum a master password may be.
 *
 * A 4-digit PIN was defensible while the wrapped blob never left the machine.
 * Once it is served to anything on the tailnet, an attacker can pull it and
 * grind offline, where Argon2id at these parameters still falls to a
 * ten-thousand-candidate keyspace in minutes. The device PIN survives as a
 * local convenience that unwraps a device-held copy; it is not this.
 */
export const MIN_MASTER_PASSWORD_LENGTH = 12;

export function generateAccountSalt(): Uint8Array {
    return randomBytes(SALT_SIZE);
}

export function deriveAccountKey(password: string, salt: Uint8Array, kdf: AccountKdf): Uint8Array {
    const passwordBytes = new TextEncoder().encode(password.normalize('NFKC'));

    if (kdf.type === 'argon2id') {
        return argon2id(passwordBytes, salt, {
            t: kdf.iterations,
            m: kdf.memory_kib ?? DEFAULT_KDF.memory_kib!,
            p: kdf.parallelism ?? 1,
            dkLen: KEY_SIZE,
        });
    }

    // Accepted because vault-warden allows it, for clients that cannot afford
    // Argon2id's memory. Not what this extension enrolls with.
    return pbkdf2(sha256, passwordBytes, salt, { c: kdf.iterations, dkLen: KEY_SIZE });
}

/* --------------------------------------------------------------- wrapping */

function packBlob(blob: EncBlob): string {
    return `${blob.nonce}.${blob.ciphertext}`;
}

function unpackBlob(packed: string): EncBlob {
    const separator = packed.indexOf('.');
    if (separator < 0) throw new Error('malformed protected key blob');
    return {
        nonce: packed.slice(0, separator),
        ciphertext: packed.slice(separator + 1),
    };
}

/** Wraps the master key for upload. The master key itself is never sent. */
export function protectMasterKey(masterKey: Uint8Array, passwordKey: Uint8Array): string {
    const { ciphertext, nonce } = encrypt(masterKey, passwordKey);
    return packBlob({ ciphertext: toBase64(ciphertext), nonce: toBase64(nonce) });
}

/** Returns null on the wrong password rather than throwing, so callers can retry. */
export function openProtectedMasterKey(protectedKey: string, passwordKey: Uint8Array): Uint8Array | null {
    try {
        const blob = unpackBlob(protectedKey);
        return decrypt(fromBase64(blob.ciphertext), fromBase64(blob.nonce), passwordKey);
    } catch {
        return null;
    }
}

export function buildAccountKeyBlob(
    masterKey: Uint8Array,
    password: string,
    kdf: AccountKdf = DEFAULT_KDF,
): AccountKeyBlob {
    const salt = generateAccountSalt();
    const passwordKey = deriveAccountKey(password, salt, kdf);
    return {
        kdf,
        salt_b64: toBase64(salt),
        protected_user_key: protectMasterKey(masterKey, passwordKey),
    };
}

export function openAccountKeyBlob(blob: AccountKeyBlob, password: string): Uint8Array | null {
    const passwordKey = deriveAccountKey(password, fromBase64(blob.salt_b64), blob.kdf);
    return openProtectedMasterKey(blob.protected_user_key, passwordKey);
}

/**
 * Re-wraps the *same* master key under a new password.
 *
 * Deliberately not a re-encrypt of the vault: because items are sealed under
 * the master key and only the master key is wrapped by the password, changing
 * the password rewrites one small blob and leaves every item untouched. That is
 * the property that makes a password change safe to do from a phone.
 */
export function rewrapForNewPassword(
    masterKey: Uint8Array,
    newPassword: string,
    kdf: AccountKdf = DEFAULT_KDF,
): AccountKeyBlob {
    return buildAccountKeyBlob(masterKey, newPassword, kdf);
}

/* -------------------------------------------------------- portable keychain */

/**
 * The device-independent part of the keychain.
 *
 * `KeychainState` also carries `deviceId`, which is per-device and must not be
 * copied to another client. Everything here is either public or encrypted under
 * the master key, so it is safe to hand to the server.
 */
export interface PortableKeychain {
    version: 1;
    kemPublicKey: string;
    sigPublicKey: string;
    kemSecretKeyEnc: EncBlob;
    sigSecretKeyEnc: EncBlob;
}

export function toPortableKeychain(state: KeychainState): PortableKeychain {
    if (!state.kemPublicKey || !state.sigPublicKey || !state.kemSecretKeyEnc || !state.sigSecretKeyEnc) {
        throw new Error('keychain is not fully initialised');
    }
    return {
        version: 1,
        kemPublicKey: state.kemPublicKey,
        sigPublicKey: state.sigPublicKey,
        kemSecretKeyEnc: state.kemSecretKeyEnc,
        sigSecretKeyEnc: state.sigSecretKeyEnc,
    };
}

/** Rebuilds local keychain state on a new device. `deviceId` stays that device's own. */
export function fromPortableKeychain(portable: PortableKeychain, deviceId: string | null): KeychainState {
    if (portable.version !== 1) {
        throw new Error(`unsupported portable keychain version ${portable.version}`);
    }
    return {
        kemPublicKey: portable.kemPublicKey,
        sigPublicKey: portable.sigPublicKey,
        kemSecretKeyEnc: portable.kemSecretKeyEnc,
        sigSecretKeyEnc: portable.sigSecretKeyEnc,
        deviceId,
    };
}

/**
 * Seals the portable keychain under the master key for storage on the server.
 *
 * The secret keys inside are already encrypted under the master key; this outer
 * layer keeps the *public* keys and the structure opaque too, so the server
 * learns nothing about which algorithms or how many keys a user holds.
 */
export function sealPortableKeychain(portable: PortableKeychain, masterKey: Uint8Array): string {
    const plaintext = new TextEncoder().encode(JSON.stringify(portable));
    const { ciphertext, nonce } = encrypt(plaintext, masterKey);
    return packBlob({ ciphertext: toBase64(ciphertext), nonce: toBase64(nonce) });
}

export function openPortableKeychain(sealed: string, masterKey: Uint8Array): PortableKeychain {
    const blob = unpackBlob(sealed);
    const plaintext = decrypt(fromBase64(blob.ciphertext), fromBase64(blob.nonce), masterKey);
    return JSON.parse(new TextDecoder().decode(plaintext)) as PortableKeychain;
}
