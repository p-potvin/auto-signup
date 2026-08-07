/**
 * Bringing the vault up on a device that has never seen it.
 *
 * The desktop unlocks from a PIN that wraps a locally-stored master key. A phone
 * has neither, so it starts from the master password and what vault-warden
 * holds, which is exactly the path `crypto/enrollment.ts` was built to make
 * possible:
 *
 *     master password --Argon2id--> password key --unwraps--> master key
 *     master key --opens--> sealed portable keychain
 *     keychain --> ML-KEM secret --opens--> item envelopes
 *
 * Kept apart from the React tree because every interesting failure lives here —
 * unreachable server, nothing enrolled, wrong password, an item that will not
 * verify — and each needs a different thing said to the user.
 */

import {
    openAccountKeyBlob,
    openPortableKeychain,
    fromPortableKeychain,
    type AccountKeyBlob,
} from '../crypto/account-key';
import { decrypt } from '../crypto/symmetric';
import { fromBase64 } from '../crypto/pqc';
import { openEnvelope } from '../crypto/envelope';
import { fetchAccountKey, fetchSealedKeychain, getIdentityVaultId } from '../api/warden';
import { pullChanges } from '../api/sync';
import type { VaultItem } from '../types';

/** What the phone can tell about the account before anyone types anything. */
export type AccountState =
    /** vault-warden did not answer. Off the tailnet, or the service is down. */
    | { status: 'unreachable'; detail: string }
    /** Reachable, but no master password has been set from another device yet. */
    | { status: 'not-enrolled'; identityVaultId: number }
    /** Ready for a password. */
    | { status: 'ready'; identityVaultId: number; accountKey: AccountKeyBlob };

export interface UnlockedVault {
    items: VaultItem[];
    /** Items the server returned that would not open. Shown, not swallowed. */
    unreadable: { id: string; reason: string }[];
}

export async function probeAccount(): Promise<AccountState> {
    let identityVaultId: number;
    try {
        identityVaultId = await getIdentityVaultId();
    } catch (e) {
        return { status: 'unreachable', detail: (e as Error).message };
    }

    let accountKey: AccountKeyBlob | null;
    try {
        accountKey = await fetchAccountKey();
    } catch (e) {
        return { status: 'unreachable', detail: (e as Error).message };
    }

    if (!accountKey) return { status: 'not-enrolled', identityVaultId };
    return { status: 'ready', identityVaultId, accountKey };
}

/**
 * The master key, or null if the password is wrong.
 *
 * Null rather than a throw: a wrong password is the expected case on a phone
 * keyboard, and a caller that has to catch to retry ends up catching real
 * failures with it.
 */
export function deriveMasterKey(accountKey: AccountKeyBlob, password: string): Uint8Array | null {
    return openAccountKeyBlob(accountKey, password);
}

/**
 * Everything the master key unlocks.
 *
 * One bad envelope does not sink the list. An item whose signature does not
 * verify is a real problem — tampering, or a keychain that does not belong to
 * this vault — but hiding the other two hundred items behind it helps nobody,
 * so failures are collected and surfaced alongside what did open.
 */
export async function openVault(
    identityVaultId: number,
    masterKey: Uint8Array,
): Promise<UnlockedVault> {
    const sealed = await fetchSealedKeychain(identityVaultId);
    if (!sealed) {
        throw new Error(
            'This account has a master password but no keychain on the server. '
            + 'Re-run enrollment from the browser extension.',
        );
    }

    const keychain = fromPortableKeychain(openPortableKeychain(sealed, masterKey), null);
    if (!keychain.kemSecretKeyEnc || !keychain.sigPublicKey) {
        throw new Error('The keychain on the server is incomplete.');
    }

    const kemSecretKey = decrypt(
        fromBase64(keychain.kemSecretKeyEnc.ciphertext),
        fromBase64(keychain.kemSecretKeyEnc.nonce),
        masterKey,
    );
    const sigPublicKey = fromBase64(keychain.sigPublicKey);

    const pulled = await pullChanges(null);

    const items: VaultItem[] = [];
    const unreadable: { id: string; reason: string }[] = [];
    for (const encrypted of pulled.items ?? []) {
        if (encrypted.deletedAt) continue;
        try {
            items.push(openEnvelope(encrypted, kemSecretKey, sigPublicKey));
        } catch (e) {
            unreadable.push({ id: encrypted.id, reason: (e as Error).message });
        }
    }

    items.sort((a, b) => a.metadata.label.localeCompare(b.metadata.label));
    return { items, unreadable };
}

/* ----------------------------------------------------------------- search */

/**
 * Substring match over the fields someone would actually search by.
 *
 * Not the item body: the point of a search box on a phone is to find the entry
 * for the site you are looking at, and matching on password text would surface
 * items for reasons the user cannot see.
 */
export function searchItems(items: VaultItem[], query: string): VaultItem[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(item => {
        // Through `unknown` because the item union has no index signature; the
        // reads below are all guarded by typeof, so a missing field is absent
        // rather than wrong.
        const data = item.data as unknown as Record<string, unknown>;
        const haystack = [
            item.metadata.label,
            item.metadata.domain ?? '',
            ...item.metadata.tags,
            typeof data.url === 'string' ? data.url : '',
            typeof data.email === 'string' ? data.email : '',
            typeof data.username === 'string' ? data.username : '',
            typeof data.issuer === 'string' ? data.issuer : '',
            typeof data.rpId === 'string' ? data.rpId : '',
        ];
        return haystack.some(field => field.toLowerCase().includes(needle));
    });
}
