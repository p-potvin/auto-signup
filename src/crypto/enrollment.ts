/**
 * Master-password enrollment: the step that turns a single-machine vault into
 * one a second device can open.
 *
 * Transport lives in `api/warden.ts`; this module is pure so the decisions can
 * be tested without a server. The rule it exists to enforce is that enrollment
 * must never be able to lose a vault — every path either produces a complete,
 * verified set of blobs or fails having changed nothing.
 */

import {
    buildAccountKeyBlob,
    openAccountKeyBlob,
    sealPortableKeychain,
    openPortableKeychain,
    toPortableKeychain,
    MIN_MASTER_PASSWORD_LENGTH,
    type AccountKeyBlob,
    type PortableKeychain,
} from './account-key';
import type { KeychainState } from '../types';

export interface EnrollmentBundle {
    accountKey: AccountKeyBlob;
    sealedKeychain: string;
}

export type PasswordProblem =
    | { ok: true }
    | { ok: false; reason: string };

/**
 * Validates a candidate master password.
 *
 * Length is the only hard rule. Composition rules (a digit, a symbol) push
 * people toward `Password1!` and buy nothing against the offline attack this
 * password actually has to survive — the wrapped key is served to the tailnet,
 * so an attacker grinds it locally and only real entropy helps.
 */
export function validateMasterPassword(password: string, confirmation?: string): PasswordProblem {
    if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
        return {
            ok: false,
            reason: `Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters. This one is wrapped on the server, where a short password can be attacked offline.`,
        };
    }
    if (/^\d+$/.test(password)) {
        return {
            ok: false,
            reason: 'Digits alone are guessable at this length. Use a passphrase.',
        };
    }
    if (confirmation !== undefined && password !== confirmation) {
        return { ok: false, reason: 'The two entries do not match.' };
    }
    return { ok: true };
}

/**
 * Builds the blobs for upload and verifies them before returning.
 *
 * The verification is not ceremony: it re-derives the master key from the blob
 * exactly as a fresh device would, and re-opens the sealed keychain from that.
 * If anything about the KDF, the wrapping or the serialisation is wrong, this
 * throws here — before the blobs are uploaded and before the user is told
 * multi-device works.
 */
export function buildEnrollment(
    masterKey: Uint8Array,
    keychain: KeychainState,
    password: string,
): EnrollmentBundle {
    const check = validateMasterPassword(password);
    if (!check.ok) throw new Error(check.reason);

    const portable = toPortableKeychain(keychain);
    const accountKey = buildAccountKeyBlob(masterKey, password);
    const sealedKeychain = sealPortableKeychain(portable, masterKey);

    assertBundleOpens({ accountKey, sealedKeychain }, password, portable);

    return { accountKey, sealedKeychain };
}

/** Re-derives everything from scratch, the way a device with only the password would. */
export function assertBundleOpens(
    bundle: EnrollmentBundle,
    password: string,
    expected: PortableKeychain,
): void {
    const recoveredKey = openAccountKeyBlob(bundle.accountKey, password);
    if (!recoveredKey) {
        throw new Error('enrollment self-check failed: the account key does not open with the password just set');
    }

    const recovered = openPortableKeychain(bundle.sealedKeychain, recoveredKey);
    const sameKeys = recovered.kemPublicKey === expected.kemPublicKey
        && recovered.sigPublicKey === expected.sigPublicKey
        && recovered.kemSecretKeyEnc.ciphertext === expected.kemSecretKeyEnc.ciphertext
        && recovered.sigSecretKeyEnc.ciphertext === expected.sigSecretKeyEnc.ciphertext;

    if (!sameKeys) {
        throw new Error('enrollment self-check failed: the sealed keychain does not round-trip');
    }
}

/* ------------------------------------------------------------- states */

export type EnrollmentState =
    /** Never set up — onboarding has not run. */
    | { status: 'uninitialised' }
    /** Local PIN only. Items are safe; no other device can read them. */
    | { status: 'local-only' }
    /** A master password is set and the blobs are on the server. */
    | { status: 'enrolled'; enrolledAt: string }
    /** Enrolled elsewhere; this device has not been bootstrapped yet. */
    | { status: 'remote-available' };

export function describeEnrollment(state: EnrollmentState): string {
    switch (state.status) {
        case 'uninitialised':
            return 'Finish setup before enabling other devices.';
        case 'local-only':
            return 'This vault exists on this browser only. Set a master password to open it from your phone.';
        case 'enrolled':
            return `Other devices can open this vault with your master password. Enrolled ${new Date(state.enrolledAt).toLocaleDateString()}.`;
        case 'remote-available':
            return 'This account already has a master password. Enter it to bring this device online.';
    }
}
