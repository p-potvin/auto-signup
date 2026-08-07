import { encrypt, decrypt } from './symmetric';
import { encapsulate, decapsulate, sign, verify, toBase64, fromBase64, canonicalJSON } from './pqc';
import type { VaultEnvelope, VaultItem, EncryptedVaultItem, ItemType, VaultItemMetadata } from '../types';

const ENVELOPE_VERSION = 2;

/**
 * Bytes that a signature commits to. Covers every field an attacker could tamper
 * with — crucially the encapsulated key and the version/type, not just the
 * ciphertext — using a canonical encoding so verification is order-independent.
 */
function signaturePayload(env: {
    version: number;
    itemType: string;
    encapsulatedKey: string;
    ciphertext: string;
    nonce: string;
    metadata: unknown;
}): Uint8Array {
    return new TextEncoder().encode(
        [env.version, env.itemType, env.encapsulatedKey, env.ciphertext, env.nonce, canonicalJSON(env.metadata)].join('|'),
    );
}

function uuid(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export function createEnvelope(
    item: VaultItem,
    kemPublicKey: Uint8Array,
    sigSecretKey: Uint8Array,
    deviceId: string,
): EncryptedVaultItem {
    const plaintext = new TextEncoder().encode(JSON.stringify(item.data));
    // KEM-DEM: the KEM shared secret *is* the data-encryption key. The previous
    // code encrypted under a throwaway random key and discarded the shared
    // secret, so nothing could ever be decrypted.
    const { ciphertext: encapsulatedKey, sharedSecret } = encapsulate(kemPublicKey);
    const { ciphertext, nonce } = encrypt(plaintext, sharedSecret);

    const envelope: VaultEnvelope = {
        version: ENVELOPE_VERSION,
        itemType: item.itemType,
        ciphertext: toBase64(ciphertext),
        nonce: toBase64(nonce),
        encapsulatedKey: toBase64(encapsulatedKey),
        metadata: { ...item.metadata, identityId: item.identityId },
        signature: '',
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        authorDeviceId: deviceId,
        lastUsedAt: item.lastUsedAt,
    };

    envelope.signature = toBase64(sign(signaturePayload(envelope), sigSecretKey));

    return { id: item.id, envelope, deletedAt: item.deletedAt };
}

export function openEnvelope(
    encryptedItem: EncryptedVaultItem,
    kemSecretKey: Uint8Array,
    sigPublicKey: Uint8Array,
): VaultItem {
    const { envelope } = encryptedItem;

    if (envelope.version !== ENVELOPE_VERSION) {
        throw new Error(`Unsupported envelope version: ${envelope.version}`);
    }

    const signature = fromBase64(envelope.signature);
    if (!verify(signaturePayload(envelope), signature, sigPublicKey)) {
        throw new Error('Envelope signature verification failed');
    }

    const encapsulatedKey = fromBase64(envelope.encapsulatedKey);
    const sharedSecret = decapsulate(kemSecretKey, encapsulatedKey);

    const ciphertext = fromBase64(envelope.ciphertext);
    const nonce = fromBase64(envelope.nonce);
    const plaintext = decrypt(ciphertext, nonce, sharedSecret);

    const data = JSON.parse(new TextDecoder().decode(plaintext));

    return {
        id: encryptedItem.id,
        itemType: envelope.itemType as ItemType,
        data,
        metadata: envelope.metadata as VaultItemMetadata,
        identityId: envelope.metadata.identityId ?? null,
        createdAt: envelope.createdAt,
        updatedAt: envelope.updatedAt,
        authorDeviceId: envelope.authorDeviceId,
        deletedAt: encryptedItem.deletedAt,
        lastUsedAt: envelope.lastUsedAt ?? null,
    };
}

/**
 * Whether this envelope was signed by the account that currently holds the vault.
 *
 * Deliberately signature-only, so it works while locked: `sigPublicKey` lives in
 * the keychain in the clear, whereas opening an item needs the master key. Sync
 * runs on a timer regardless of lock state and is exactly where this check has
 * to happen.
 *
 * The case it exists for is key rotation. Items sealed by a retired keychain
 * cannot be opened by the new one — ever — but the sync protocol has no idea:
 * it pulled them back down, wrote them to local storage, and pushed them again
 * on the next round, so a rotation left permanently unreadable items multiplying
 * across every device.
 */
export function isSignedByThisAccount(
    encryptedItem: EncryptedVaultItem,
    sigPublicKey: Uint8Array,
): boolean {
    const { envelope } = encryptedItem;
    if (!envelope || envelope.version !== ENVELOPE_VERSION) return false;
    try {
        return verify(signaturePayload(envelope), fromBase64(envelope.signature), sigPublicKey);
    } catch {
        // Malformed base64, wrong key length, truncated blob — all "not ours".
        return false;
    }
}

export function createVaultItem(
    itemType: ItemType,
    data: import('../types').VaultItemData,
    metadata: VaultItemMetadata,
    deviceId: string,
): VaultItem {
    const now = new Date().toISOString();
    return {
        id: uuid(),
        itemType,
        data,
        metadata,
        identityId: null,
        createdAt: now,
        updatedAt: now,
        authorDeviceId: deviceId,
        deletedAt: null,
        lastUsedAt: null,
    };
}

export function updateVaultItemTimestamp(item: VaultItem): VaultItem {
    return { ...item, updatedAt: new Date().toISOString() };
}
