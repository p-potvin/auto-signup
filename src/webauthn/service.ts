/**
 * Background-side passkey service.
 *
 * Bridges the authenticator to the encrypted vault: finds the credentials that
 * apply to a ceremony, runs it, and persists new ones as ordinary vault items
 * so they sync, back up, and lock with everything else.
 */

import {
    getAssertion,
    isRpIdAllowed,
    defaultRpId,
    makeCredential,
    selectCredential,
    supportsRequestedAlgorithm,
    type StoredCredential,
} from './authenticator';
import { COSE_ALG_ES256 } from './encoding';
import type {
    CeremonySummary,
    SerializedAssertionResponse,
    SerializedAttestationResponse,
    SerializedCreationOptions,
    SerializedRequestOptions,
    WebAuthnErrorName,
} from './types';
import type { PasskeyItem, VaultItem, VaultItemMetadata } from '../types';

export class WebAuthnError extends Error {
    constructor(public readonly errorName: WebAuthnErrorName, message: string) {
        super(message);
        this.name = 'WebAuthnError';
    }
}

export interface PasskeyRecord {
    itemId: string;
    passkey: PasskeyItem;
}

/** Everything the service needs from the vault, injected so it stays testable. */
export interface VaultAccess {
    listPasskeys: () => Promise<PasskeyRecord[]>;
    createItem: (
        itemType: 'passkey',
        data: PasskeyItem,
        metadata: VaultItemMetadata,
    ) => Promise<VaultItem>;
    touchItem: (itemId: string) => Promise<void>;
    isUnlocked: () => Promise<boolean>;
}

function assertRpId(rpId: string, origin: string): void {
    if (!isRpIdAllowed(rpId, origin)) {
        throw new WebAuthnError(
            'SecurityError',
            `The relying party ID "${rpId}" is not permitted for origin ${origin}.`,
        );
    }
}

function toStoredCredential(record: PasskeyRecord): StoredCredential {
    return {
        credentialId: record.passkey.credentialId,
        rpId: record.passkey.rpId,
        userHandle: record.passkey.userHandle,
        userName: record.passkey.userName ?? '',
        privateKeyPkcs8: record.passkey.privateKey,
        publicKeySpki: record.passkey.publicKey ?? '',
    };
}

/**
 * Credentials this authenticator can actually assert with for `rpId`.
 *
 * Records typed in by hand before v2.1 have no usable PKCS#8 private key, so
 * they are excluded — offering them would produce a signature the relying party
 * rejects, with no way for the user to tell why.
 */
async function usableCredentials(vault: VaultAccess, rpId: string): Promise<PasskeyRecord[]> {
    const all = await vault.listPasskeys();
    return all.filter(record =>
        record.passkey.rpId.toLowerCase() === rpId.toLowerCase()
        && !!record.passkey.privateKey
        && record.passkey.createdByAuthenticator !== false);
}

/* ----------------------------------------------------------------- prepare */

export interface PrepareResult {
    enabled: boolean;
    locked: boolean;
    summary: CeremonySummary;
    accounts: { credentialId: string; userName: string; userDisplayName: string }[];
}

export async function prepareCeremony(
    kind: 'create' | 'get',
    origin: string,
    options: SerializedCreationOptions | SerializedRequestOptions,
    vault: VaultAccess,
    passkeysEnabled: boolean,
): Promise<PrepareResult> {
    const rpId = kind === 'create'
        ? ((options as SerializedCreationOptions).rp?.id ?? defaultRpId(origin))
        : ((options as SerializedRequestOptions).rpId ?? defaultRpId(origin));

    assertRpId(rpId, origin);

    const unlocked = await vault.isUnlocked();

    if (kind === 'create') {
        const creation = options as SerializedCreationOptions;
        if (!supportsRequestedAlgorithm(creation)) {
            throw new WebAuthnError(
                'NotSupportedError',
                'This site requires a key algorithm VaultWares does not issue (ES256 only).',
            );
        }
        return {
            enabled: passkeysEnabled,
            locked: !unlocked,
            summary: {
                rpId,
                rpName: creation.rp?.name || rpId,
                userName: creation.user?.name ?? '',
                userDisplayName: creation.user?.displayName ?? '',
                credentialCount: 0,
            },
            accounts: [],
        };
    }

    // A locked vault cannot decrypt items, so the account list is empty until
    // the user unlocks; the bridge re-prepares afterwards.
    const records = unlocked ? await usableCredentials(vault, rpId) : [];
    const request = options as SerializedRequestOptions;
    const allowed = request.allowCredentials ?? [];
    const allowedIds = new Set(allowed.map(c => c.id));
    const matching = allowed.length
        ? records.filter(r => allowedIds.has(r.passkey.credentialId))
        : records;

    return {
        enabled: passkeysEnabled,
        locked: !unlocked,
        summary: {
            rpId,
            rpName: matching[0]?.passkey.rpName || rpId,
            userName: '',
            userDisplayName: '',
            credentialCount: matching.length,
        },
        accounts: matching.map(r => ({
            credentialId: r.passkey.credentialId,
            userName: r.passkey.userName ?? r.passkey.rpId,
            userDisplayName: r.passkey.userDisplayName ?? r.passkey.userName ?? r.passkey.rpId,
        })),
    };
}

/* ------------------------------------------------------------------ create */

export async function performCreate(
    origin: string,
    options: SerializedCreationOptions,
    vault: VaultAccess,
): Promise<SerializedAttestationResponse> {
    const rpId = options.rp?.id ?? defaultRpId(origin);
    assertRpId(rpId, origin);

    if (!await vault.isUnlocked()) {
        throw new WebAuthnError('NotAllowedError', 'The vault is locked.');
    }
    if (!supportsRequestedAlgorithm(options)) {
        throw new WebAuthnError(
            'NotSupportedError',
            'This site requires a key algorithm VaultWares does not issue (ES256 only).',
        );
    }

    // excludeCredentials exists so a site can stop a second credential being
    // registered for an account that already has one.
    const excluded = options.excludeCredentials ?? [];
    if (excluded.length) {
        const existing = await usableCredentials(vault, rpId);
        const excludedIds = new Set(excluded.map(c => c.id));
        if (existing.some(r => excludedIds.has(r.passkey.credentialId))) {
            throw new WebAuthnError(
                'InvalidStateError',
                'A passkey for this account already exists in the vault.',
            );
        }
    }

    const created = await makeCredential(options, origin, true);

    const passkey: PasskeyItem = {
        rpId: created.rpId,
        rpName: created.rpName,
        credentialId: created.credentialId,
        privateKey: created.privateKeyPkcs8,
        publicKey: created.publicKeySpki,
        userHandle: created.userHandle,
        userName: created.userName,
        userDisplayName: created.userDisplayName,
        algorithm: COSE_ALG_ES256,
        createdByAuthenticator: true,
        createdAt: new Date().toISOString(),
    };

    await vault.createItem('passkey', passkey, {
        label: created.userName ? `${created.rpName} (${created.userName})` : created.rpName,
        domain: created.rpId,
        tags: ['passkey'],
        favorite: false,
    });

    return {
        id: created.credentialId,
        rawId: created.credentialId,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
            clientDataJSON: created.clientDataJSON,
            attestationObject: created.attestationObject,
            transports: ['internal', 'hybrid'],
            publicKeyAlgorithm: COSE_ALG_ES256,
            publicKey: created.publicKeySpki,
            authenticatorData: created.authenticatorData,
        },
    };
}

/* --------------------------------------------------------------------- get */

export async function performGet(
    origin: string,
    options: SerializedRequestOptions,
    vault: VaultAccess,
    chosenCredentialId: string | undefined,
): Promise<SerializedAssertionResponse> {
    const rpId = options.rpId ?? defaultRpId(origin);
    assertRpId(rpId, origin);

    if (!await vault.isUnlocked()) {
        throw new WebAuthnError('NotAllowedError', 'The vault is locked.');
    }

    const records = await usableCredentials(vault, rpId);
    if (records.length === 0) {
        throw new WebAuthnError('NotAllowedError', 'No passkey for this site is stored in the vault.');
    }

    const chosen = chosenCredentialId
        ? records.find(r => r.passkey.credentialId === chosenCredentialId)
        : undefined;

    const credential = chosen
        ? toStoredCredential(chosen)
        : selectCredential(options, records.map(toStoredCredential));

    if (!credential) {
        throw new WebAuthnError('NotAllowedError', 'No passkey matched this sign-in request.');
    }

    const assertion = await getAssertion(options, origin, credential, true);

    const record = records.find(r => r.passkey.credentialId === credential.credentialId);
    if (record) await vault.touchItem(record.itemId);

    return {
        id: assertion.credentialId,
        rawId: assertion.credentialId,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
            clientDataJSON: assertion.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: assertion.signature,
            userHandle: assertion.userHandle || null,
        },
    };
}
