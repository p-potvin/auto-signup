import { initKeychain, wrapAndStoreMasterKey, unwrapMasterKey, setCachedMasterKey, getCachedMasterKey, setDeviceId, getKeychain, isInitialized, getKemPublicKey, getSigKeyPair, getKemSecretKey, clearKeychain } from '../crypto/keychain';
import { createEnvelope, openEnvelope, createVaultItem, updateVaultItemTimestamp } from '../crypto/envelope';
import { generateRecoveryKit, downloadRecoveryKit } from '../crypto/recovery';
import { getEncryptedItems, saveEncryptedItem, deleteEncryptedItem, replaceAllEncryptedItems, getSettings, saveSettings, getSyncCursor, setSyncCursor } from '../utils/storage';
import { getEncryptedIdentities, saveEncryptedIdentity, deleteEncryptedIdentity, encryptIdentity, decryptIdentity } from '../utils/identity-storage';
import { register as apiRegister } from '../api/auth';
import { createVaultItem as apiCreateItem, updateVaultItem as apiUpdateItem, deleteVaultItem as apiDeleteItem } from '../api/vault';
import { pushChanges, pullChanges } from '../api/sync';
import { enqueueCreate, enqueueUpdate, enqueueDelete, processQueue, fullSync, startAutoSync } from '../api/sync-queue';
import { generateIdentity as generateIdentityApi } from '../api/generation';
import { prepareCeremony, performCreate, performGet, WebAuthnError, type PasskeyRecord, type VaultAccess } from '../webauthn/service';
import type { SerializedCreationOptions, SerializedRequestOptions } from '../webauthn/types';
import type { VaultItem, EncryptedVaultItem, ItemType, VaultItemData, VaultItemMetadata, VaultSettings, RecoveryKit, Identity, GeneratedIdentityData, PasskeyItem, LoginItem } from '../types';

export type MessageType =
    | 'INIT_CHECK'
    | 'SETUP_ACCOUNT'
    | 'UNLOCK'
    | 'LOCK'
    | 'GET_UNLOCKED'
    | 'GET_ITEMS'
    | 'CREATE_ITEM'
    | 'UPDATE_ITEM'
    | 'DELETE_ITEM'
    | 'GET_SETTINGS'
    | 'SAVE_SETTINGS'
    | 'GENERATE_RECOVERY_KIT'
    | 'DOWNLOAD_RECOVERY_KIT'
    | 'SYNC'
    | 'GET_PAGE_MATCHES'
    | 'OPEN_POPUP_CREATE'
    | 'GET_IDENTITIES'
    | 'CREATE_IDENTITY'
    | 'UPDATE_IDENTITY'
    | 'DELETE_IDENTITY'
    | 'GENERATE_IDENTITY'
    | 'ASSIGN_ITEM_TO_IDENTITY'
    | 'UNASSIGN_ITEM_FROM_IDENTITY'
    | 'UPDATE_ITEM_LAST_USED'
    | 'WEBAUTHN_PREPARE'
    | 'WEBAUTHN_CREATE'
    | 'WEBAUTHN_GET'
    | 'OPEN_VAULT_UNLOCK'
    | 'QUEUE_SAVE_PROMPT'
    | 'GET_PENDING_SAVE'
    | 'CLEAR_PENDING_SAVE'
    | 'SAVE_LOGIN_FROM_PAGE';

export interface Message {
    type: MessageType;
    payload?: any;
}

export interface MessageResponse {
    success: boolean;
    data?: any;
    error?: string;
    /** Set for WebAuthn failures so the page can throw the right DOMException. */
    errorName?: string;
}

let lockTimer: ReturnType<typeof setTimeout> | null = null;

function resetLockTimer(): void {
    if (lockTimer) clearTimeout(lockTimer);
    getSettings().then(settings => {
        if (settings.autoLockMinutes > 0) {
            lockTimer = setTimeout(() => {
                setCachedMasterKey(null);
            }, settings.autoLockMinutes * 60 * 1000);
        }
    });
}

async function handleSetupAccount(payload: { email: string; pin: string }): Promise<MessageResponse> {
    try {
        const { kemPublicKey, sigPublicKey, masterKey } = await initKeychain();
        await wrapAndStoreMasterKey(masterKey, payload.pin);

        // Vault sync is local (see api/sync.ts), so account registration with the
        // cloud is optional. Try it for the AI-generation account, but fall back
        // to a locally-generated device id so the extension works fully offline.
        let deviceId: string;
        let deviceRole = 'master';
        try {
            const resp = await apiRegister({
                email: payload.email,
                kemPublicKey,
                sigPublicKey,
                deviceName: navigator.userAgent.includes('Firefox') ? 'Firefox Browser' : 'Chrome Browser',
                deviceClass: 'browser',
                platform: navigator.platform,
            });
            deviceId = resp.deviceId;
            deviceRole = resp.deviceRole;
        } catch (e) {
            console.warn('Cloud registration unavailable, continuing local-only:', (e as Error).message);
            deviceId = crypto.randomUUID();
        }

        await setDeviceId(deviceId);
        await setCachedMasterKey(masterKey);
        resetLockTimer();

        return { success: true, data: { deviceId, deviceRole } };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleUnlock(payload: { pin: string }): Promise<MessageResponse> {
    try {
        const masterKey = await unwrapMasterKey(payload.pin);
        if (!masterKey) {
            return { success: false, error: 'Invalid PIN' };
        }
        await setCachedMasterKey(masterKey);
        resetLockTimer();
        return { success: true };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleLock(): Promise<MessageResponse> {
    await setCachedMasterKey(null);
    if (lockTimer) clearTimeout(lockTimer);
    return { success: true };
}

async function handleGetUnlocked(): Promise<MessageResponse> {
    const key = await getCachedMasterKey();
    return { success: true, data: { unlocked: key !== null } };
}

async function handleGetItems(): Promise<MessageResponse> {
    try {
        const encryptedItems = await getEncryptedItems();
        const kemSecretKey = await getKemSecretKey();
        const sigKp = await getSigKeyPair();

        if (!kemSecretKey || !sigKp) {
            return { success: false, error: 'Keychain not initialized' };
        }

        const masterKey = await getCachedMasterKey();
        if (!masterKey) {
            return { success: false, error: 'Vault is locked' };
        }

        const items: VaultItem[] = [];
        for (const enc of encryptedItems) {
            if (enc.deletedAt) continue;
            try {
                const item = openEnvelope(enc, kemSecretKey, sigKp.publicKey);
                items.push(item);
            } catch (e) {
                console.error('Failed to decrypt item:', enc.id, e);
            }
        }

        return { success: true, data: items };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleCreateItem(payload: { itemType: ItemType; data: VaultItemData; metadata: VaultItemMetadata }): Promise<MessageResponse> {
    try {
        const keychain = await getKeychain();
        if (!keychain?.deviceId) return { success: false, error: 'No device ID' };

        const kemPubKey = await getKemPublicKey();
        const sigKp = await getSigKeyPair();
        if (!kemPubKey || !sigKp) return { success: false, error: 'Keychain not initialized' };

        const item = createVaultItem(payload.itemType, payload.data, payload.metadata, keychain.deviceId);
        const encrypted = createEnvelope(item, kemPubKey, sigKp.secretKey, keychain.deviceId);

        await saveEncryptedItem(encrypted);
        await enqueueCreate(encrypted);

        return { success: true, data: item };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleUpdateItem(payload: { id: string; data: VaultItemData; metadata: VaultItemMetadata }): Promise<MessageResponse> {
    try {
        const keychain = await getKeychain();
        if (!keychain?.deviceId) return { success: false, error: 'No device ID' };

        const kemPubKey = await getKemPublicKey();
        const sigKp = await getSigKeyPair();
        if (!kemPubKey || !sigKp) return { success: false, error: 'Keychain not initialized' };

        const encryptedItems = await getEncryptedItems();
        const existing = encryptedItems.find(i => i.id === payload.id);
        if (!existing) return { success: false, error: 'Item not found' };

        const kemSecretKey = await getKemSecretKey();
        if (!kemSecretKey) return { success: false, error: 'Keychain not initialized' };

        const item = openEnvelope(existing, kemSecretKey, sigKp.publicKey);
        const updated: VaultItem = {
            ...item,
            data: payload.data,
            metadata: payload.metadata,
            updatedAt: new Date().toISOString(),
        };

        const encrypted = createEnvelope(updated, kemPubKey, sigKp.secretKey, keychain.deviceId);
        await saveEncryptedItem(encrypted);
        await enqueueUpdate(encrypted);

        return { success: true, data: updated };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleDeleteItem(payload: { id: string }): Promise<MessageResponse> {
    try {
        await deleteEncryptedItem(payload.id);
        await enqueueDelete(payload.id);

        return { success: true };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleGetSettings(): Promise<MessageResponse> {
    const settings = await getSettings();
    return { success: true, data: settings };
}

async function handleSaveSettings(payload: VaultSettings): Promise<MessageResponse> {
    await saveSettings(payload);
    return { success: true };
}

async function handleGenerateRecoveryKit(payload: { pin: string }): Promise<MessageResponse> {
    try {
        const masterKey = await getCachedMasterKey();
        if (!masterKey) return { success: false, error: 'Vault is locked' };

        const kit = await generateRecoveryKit(masterKey, payload.pin);
        return { success: true, data: kit };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleDownloadRecoveryKit(payload: { kit: RecoveryKit }): Promise<MessageResponse> {
    try {
        downloadRecoveryKit(payload.kit);
        return { success: true };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleSync(): Promise<MessageResponse> {
    try {
        const queueResult = await processQueue();
        const syncResult = await fullSync();
        return { success: true, data: { ...syncResult, ...queueResult } };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleGetPageMatches(payload: { url: string }): Promise<MessageResponse> {
    try {
        const items = await getEncryptedItems();
        const kemSecretKey = await getKemSecretKey();
        const sigKp = await getSigKeyPair();

        if (!kemSecretKey || !sigKp) return { success: true, data: [] };

        const masterKey = await getCachedMasterKey();
        if (!masterKey) return { success: true, data: [] };

        const { normalizeDomain, domainMatches, urlMatches } = await import('../utils/domain');
        const pageDomain = normalizeDomain(payload.url);

        const exactMatches: VaultItem[] = [];
        const fuzzyMatches: VaultItem[] = [];

        for (const enc of items) {
            if (enc.deletedAt) continue;
            const itemDomain = enc.envelope.metadata.domain || '';
            const isExact = itemDomain === pageDomain;
            const isFuzzy = !isExact && domainMatches(itemDomain, payload.url);

            if (isExact || isFuzzy) {
                try {
                    const item = openEnvelope(enc, kemSecretKey, sigKp.publicKey);
                    if (isExact) exactMatches.push(item);
                    else fuzzyMatches.push(item);
                } catch (e) {
                    console.error('Failed to decrypt item:', enc.id, e);
                }
                continue;
            }

            if (enc.envelope.itemType === 'login') {
                try {
                    const item = openEnvelope(enc, kemSecretKey, sigKp.publicKey);
                    const loginData = item.data as import('../types').LoginItem;
                    if (loginData.url && urlMatches(loginData.url, payload.url)) {
                        fuzzyMatches.push(item);
                    }
                } catch (e) {
                    console.error('Failed to decrypt item:', enc.id, e);
                }
            }
        }

        const allMatches = [...exactMatches, ...fuzzyMatches];
        return { success: true, data: allMatches };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

function createIdentityObject(data: GeneratedIdentityData, deviceId: string): Identity {
    const now = new Date().toISOString();
    return {
        id: crypto.randomUUID(),
        fullName: data.fullName,
        gender: data.gender,
        birthDate: data.birthDate,
        nationality: data.nationality,
        bio: data.bio,
        email: data.email,
        phone: data.phone,
        address: data.address,
        facePhoto: null,
        metadata: { tags: [], favorite: false },
        createdAt: now,
        updatedAt: now,
        authorDeviceId: deviceId,
        deletedAt: null,
        lastUsedAt: null,
    };
}

async function handleGetIdentities(): Promise<MessageResponse> {
    try {
        const encIdentities = await getEncryptedIdentities();
        const kemSecretKey = await getKemSecretKey();
        const sigKp = await getSigKeyPair();
        if (!kemSecretKey || !sigKp) return { success: true, data: [] };

        const masterKey = await getCachedMasterKey();
        if (!masterKey) return { success: true, data: [] };

        const identities: Identity[] = [];
        for (const enc of encIdentities) {
            if (enc.deletedAt) continue;
            try {
                identities.push(decryptIdentity(enc, kemSecretKey, sigKp.publicKey));
            } catch (e) {
                console.error('Failed to decrypt identity:', enc.id, e);
            }
        }
        return { success: true, data: identities };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleCreateIdentity(payload: { data: GeneratedIdentityData }): Promise<MessageResponse> {
    try {
        const keychain = await getKeychain();
        if (!keychain?.deviceId) return { success: false, error: 'No device ID' };

        const kemPubKey = await getKemPublicKey();
        const sigKp = await getSigKeyPair();
        if (!kemPubKey || !sigKp) return { success: false, error: 'Keychain not initialized' };

        const identity = createIdentityObject(payload.data, keychain.deviceId);
        const encrypted = encryptIdentity(identity, kemPubKey, sigKp.secretKey, keychain.deviceId);
        await saveEncryptedIdentity(encrypted);

        return { success: true, data: identity };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleUpdateIdentity(payload: { identity: Identity }): Promise<MessageResponse> {
    try {
        const keychain = await getKeychain();
        if (!keychain?.deviceId) return { success: false, error: 'No device ID' };

        const kemPubKey = await getKemPublicKey();
        const sigKp = await getSigKeyPair();
        if (!kemPubKey || !sigKp) return { success: false, error: 'Keychain not initialized' };

        const updated: Identity = { ...payload.identity, updatedAt: new Date().toISOString() };
        const encrypted = encryptIdentity(updated, kemPubKey, sigKp.secretKey, keychain.deviceId);
        await saveEncryptedIdentity(encrypted);

        return { success: true, data: updated };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleDeleteIdentity(payload: { id: string }): Promise<MessageResponse> {
    try {
        await deleteEncryptedIdentity(payload.id);
        return { success: true };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleGenerateIdentity(payload?: { options?: any }): Promise<MessageResponse> {
    try {
        const settings = await getSettings();
        const data = await generateIdentityApi(settings.generationEndpointUrl || undefined, payload?.options);
        return { success: true, data };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleAssignItemToIdentity(payload: { itemId: string; identityId: string }): Promise<MessageResponse> {
    try {
        const keychain = await getKeychain();
        if (!keychain?.deviceId) return { success: false, error: 'No device ID' };

        const kemPubKey = await getKemPublicKey();
        const sigKp = await getSigKeyPair();
        if (!kemPubKey || !sigKp) return { success: false, error: 'Keychain not initialized' };

        const items = await getEncryptedItems();
        const enc = items.find(i => i.id === payload.itemId);
        if (!enc) return { success: false, error: 'Item not found' };

        const kemSecretKey = await getKemSecretKey();
        if (!kemSecretKey) return { success: false, error: 'Keychain not initialized' };

        const item = openEnvelope(enc, kemSecretKey, sigKp.publicKey);
        const updated: VaultItem = { ...item, identityId: payload.identityId, updatedAt: new Date().toISOString() };
        const reencrypted = createEnvelope(updated, kemPubKey, sigKp.secretKey, keychain.deviceId);
        await saveEncryptedItem(reencrypted);

        return { success: true, data: updated };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleUnassignItemFromIdentity(payload: { itemId: string }): Promise<MessageResponse> {
    try {
        const keychain = await getKeychain();
        if (!keychain?.deviceId) return { success: false, error: 'No device ID' };

        const kemPubKey = await getKemPublicKey();
        const sigKp = await getSigKeyPair();
        if (!kemPubKey || !sigKp) return { success: false, error: 'Keychain not initialized' };

        const items = await getEncryptedItems();
        const enc = items.find(i => i.id === payload.itemId);
        if (!enc) return { success: false, error: 'Item not found' };

        const kemSecretKey = await getKemSecretKey();
        if (!kemSecretKey) return { success: false, error: 'Keychain not initialized' };

        const item = openEnvelope(enc, kemSecretKey, sigKp.publicKey);
        const updated: VaultItem = { ...item, identityId: null, updatedAt: new Date().toISOString() };
        const reencrypted = createEnvelope(updated, kemPubKey, sigKp.secretKey, keychain.deviceId);
        await saveEncryptedItem(reencrypted);

        return { success: true, data: updated };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleUpdateItemLastUsed(payload: { itemId: string }): Promise<MessageResponse> {
    try {
        const keychain = await getKeychain();
        if (!keychain?.deviceId) return { success: false, error: 'No device ID' };

        const kemPubKey = await getKemPublicKey();
        const sigKp = await getSigKeyPair();
        if (!kemPubKey || !sigKp) return { success: false, error: 'Keychain not initialized' };

        const items = await getEncryptedItems();
        const enc = items.find(i => i.id === payload.itemId);
        if (!enc) return { success: false, error: 'Item not found' };

        const kemSecretKey = await getKemSecretKey();
        if (!kemSecretKey) return { success: false, error: 'Keychain not initialized' };

        const item = openEnvelope(enc, kemSecretKey, sigKp.publicKey);
        const updated: VaultItem = { ...item, lastUsedAt: new Date().toISOString() };
        const reencrypted = createEnvelope(updated, kemPubKey, sigKp.secretKey, keychain.deviceId);
        await saveEncryptedItem(reencrypted);

        return { success: true };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

/* ------------------------------------------------------------- passkeys */

/**
 * Vault surface handed to the passkey service. Reuses the same envelope path as
 * every other item, so passkeys are encrypted, synced, and locked identically.
 */
const passkeyVaultAccess: VaultAccess = {
    isUnlocked: async () => (await getCachedMasterKey()) !== null,

    listPasskeys: async (): Promise<PasskeyRecord[]> => {
        const kemSecretKey = await getKemSecretKey();
        const sigKp = await getSigKeyPair();
        if (!kemSecretKey || !sigKp) return [];

        const records: PasskeyRecord[] = [];
        for (const enc of await getEncryptedItems()) {
            if (enc.deletedAt || enc.envelope.itemType !== 'passkey') continue;
            try {
                const item = openEnvelope(enc, kemSecretKey, sigKp.publicKey);
                records.push({ itemId: item.id, passkey: item.data as PasskeyItem });
            } catch (e) {
                console.error('Failed to decrypt passkey:', enc.id, e);
            }
        }
        return records;
    },

    createItem: async (itemType, data, metadata) => {
        const response = await handleCreateItem({ itemType, data, metadata });
        if (!response.success) throw new Error(response.error ?? 'Could not store the passkey');
        return response.data as VaultItem;
    },

    touchItem: async (itemId: string) => {
        await handleUpdateItemLastUsed({ itemId });
    },
};

function webAuthnFailure(e: unknown): MessageResponse {
    if (e instanceof WebAuthnError) {
        return { success: false, error: e.message, errorName: e.errorName };
    }
    return { success: false, error: (e as Error).message, errorName: 'NotAllowedError' };
}

async function handleWebAuthnPrepare(payload: {
    kind: 'create' | 'get';
    origin: string;
    options: SerializedCreationOptions | SerializedRequestOptions;
}): Promise<MessageResponse> {
    try {
        const settings = await getSettings();
        const result = await prepareCeremony(
            payload.kind,
            payload.origin,
            payload.options,
            passkeyVaultAccess,
            settings.passkeysEnabled,
        );
        return { success: true, data: result };
    } catch (e) {
        return webAuthnFailure(e);
    }
}

async function handleWebAuthnCreate(payload: {
    origin: string;
    options: SerializedCreationOptions;
}): Promise<MessageResponse> {
    try {
        const settings = await getSettings();
        if (!settings.passkeysEnabled) {
            return { success: false, error: 'Passkeys are disabled in VaultWares settings', errorName: 'NotAllowedError' };
        }
        const result = await performCreate(payload.origin, payload.options, passkeyVaultAccess);
        return { success: true, data: result };
    } catch (e) {
        return webAuthnFailure(e);
    }
}

async function handleWebAuthnGet(payload: {
    origin: string;
    options: SerializedRequestOptions;
    credentialId?: string;
}): Promise<MessageResponse> {
    try {
        const settings = await getSettings();
        if (!settings.passkeysEnabled) {
            return { success: false, error: 'Passkeys are disabled in VaultWares settings', errorName: 'NotAllowedError' };
        }
        const result = await performGet(
            payload.origin,
            payload.options,
            passkeyVaultAccess,
            payload.credentialId,
        );
        return { success: true, data: result };
    } catch (e) {
        return webAuthnFailure(e);
    }
}

/* ---------------------------------------------------------- save prompt */

interface PendingSave {
    url: string;
    username: string;
    password: string;
    decision: { status: 'new' | 'existing'; itemId?: string; samePassword?: boolean };
    expiresAt: number;
}

/**
 * Submitted credentials awaiting a save decision, keyed by tab.
 *
 * Held in worker memory only and never written to storage: a submit that
 * navigates destroys the content script before the user can answer, so the
 * prompt has to survive one page load — but no longer, and not on disk.
 */
const pendingSaves = new Map<number, PendingSave>();
const PENDING_SAVE_TTL_MS = 2 * 60 * 1000;

function prunePendingSaves(): void {
    const now = Date.now();
    for (const [tabId, pending] of pendingSaves) {
        if (pending.expiresAt < now) pendingSaves.delete(tabId);
    }
}

chrome.tabs.onRemoved.addListener(tabId => pendingSaves.delete(tabId));

/**
 * Reports whether a submitted credential is new, already stored, or a changed
 * password for a known account — so the content script can ask the right
 * question instead of offering to save a duplicate.
 */
async function handleFindLoginForSave(payload: {
    url: string;
    username: string;
    password: string;
}): Promise<MessageResponse> {
    try {
        if (!await passkeyVaultAccess.isUnlocked()) {
            return { success: true, data: { status: 'locked' } };
        }

        const kemSecretKey = await getKemSecretKey();
        const sigKp = await getSigKeyPair();
        if (!kemSecretKey || !sigKp) return { success: true, data: { status: 'locked' } };

        const { normalizeDomain } = await import('../utils/domain');
        const domain = normalizeDomain(payload.url);
        const username = payload.username.trim().toLowerCase();

        for (const enc of await getEncryptedItems()) {
            if (enc.deletedAt || enc.envelope.itemType !== 'login') continue;
            if ((enc.envelope.metadata.domain || '') !== domain) continue;

            const item = openEnvelope(enc, kemSecretKey, sigKp.publicKey);
            const login = item.data as LoginItem;
            if ((login.username ?? '').trim().toLowerCase() !== username) continue;

            return {
                success: true,
                data: {
                    status: 'existing',
                    itemId: item.id,
                    // Identical credentials mean there is nothing to ask about.
                    samePassword: login.password === payload.password,
                },
            };
        }

        return { success: true, data: { status: 'new' } };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

async function handleQueueSavePrompt(
    payload: { url: string; username: string; password: string },
    tabId: number | undefined,
): Promise<MessageResponse> {
    const response = await handleFindLoginForSave(payload);
    if (!response.success) return response;

    const decision = response.data as PendingSave['decision'] | { status: 'locked' };
    prunePendingSaves();

    const actionable = decision.status === 'new'
        || (decision.status === 'existing' && !(decision as PendingSave['decision']).samePassword);

    if (tabId !== undefined && actionable) {
        pendingSaves.set(tabId, {
            ...payload,
            decision: decision as PendingSave['decision'],
            expiresAt: Date.now() + PENDING_SAVE_TTL_MS,
        });
    }

    return { success: true, data: decision };
}

function handleGetPendingSave(tabId: number | undefined): MessageResponse {
    prunePendingSaves();
    if (tabId === undefined) return { success: true, data: null };
    return { success: true, data: pendingSaves.get(tabId) ?? null };
}

async function handleSaveLoginFromPage(payload: {
    url: string;
    username: string;
    password: string;
    itemId?: string;
}): Promise<MessageResponse> {
    try {
        const { normalizeDomain, getFullDomain } = await import('../utils/domain');
        const domain = normalizeDomain(payload.url);

        if (payload.itemId) {
            const kemSecretKey = await getKemSecretKey();
            const sigKp = await getSigKeyPair();
            if (!kemSecretKey || !sigKp) return { success: false, error: 'Keychain not initialized' };

            const enc = (await getEncryptedItems()).find(i => i.id === payload.itemId);
            if (!enc) return { success: false, error: 'Item not found' };

            const item = openEnvelope(enc, kemSecretKey, sigKp.publicKey);
            const login = item.data as LoginItem;
            return handleUpdateItem({
                id: item.id,
                data: { ...login, password: payload.password },
                metadata: item.metadata,
            });
        }

        return handleCreateItem({
            itemType: 'login',
            data: {
                url: payload.url,
                username: payload.username,
                password: payload.password,
            } satisfies LoginItem,
            metadata: {
                label: getFullDomain(payload.url) || domain,
                domain,
                tags: [],
                favorite: false,
            },
        });
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
    (async () => {
        let response: MessageResponse;

        switch (message.type) {
            case 'INIT_CHECK':
                response = { success: true, data: { initialized: await isInitialized() } };
                break;
            case 'SETUP_ACCOUNT':
                response = await handleSetupAccount(message.payload);
                break;
            case 'UNLOCK':
                response = await handleUnlock(message.payload);
                break;
            case 'LOCK':
                response = await handleLock();
                break;
            case 'GET_UNLOCKED':
                response = await handleGetUnlocked();
                break;
            case 'GET_ITEMS':
                response = await handleGetItems();
                break;
            case 'CREATE_ITEM':
                response = await handleCreateItem(message.payload);
                break;
            case 'UPDATE_ITEM':
                response = await handleUpdateItem(message.payload);
                break;
            case 'DELETE_ITEM':
                response = await handleDeleteItem(message.payload);
                break;
            case 'GET_SETTINGS':
                response = await handleGetSettings();
                break;
            case 'SAVE_SETTINGS':
                response = await handleSaveSettings(message.payload);
                break;
            case 'GENERATE_RECOVERY_KIT':
                response = await handleGenerateRecoveryKit(message.payload);
                break;
            case 'DOWNLOAD_RECOVERY_KIT':
                response = await handleDownloadRecoveryKit(message.payload);
                break;
            case 'SYNC':
                response = await handleSync();
                break;
            case 'GET_PAGE_MATCHES':
                response = await handleGetPageMatches(message.payload);
                break;
            case 'OPEN_POPUP_CREATE':
                chrome.tabs.create({ url: chrome.runtime.getURL('vault.html?action=create&url=' + encodeURIComponent(message.payload?.url || '')) });
                response = { success: true };
                break;
            case 'GET_IDENTITIES':
                response = await handleGetIdentities();
                break;
            case 'CREATE_IDENTITY':
                response = await handleCreateIdentity(message.payload);
                break;
            case 'UPDATE_IDENTITY':
                response = await handleUpdateIdentity(message.payload);
                break;
            case 'DELETE_IDENTITY':
                response = await handleDeleteIdentity(message.payload);
                break;
            case 'GENERATE_IDENTITY':
                response = await handleGenerateIdentity(message.payload);
                break;
            case 'ASSIGN_ITEM_TO_IDENTITY':
                response = await handleAssignItemToIdentity(message.payload);
                break;
            case 'UNASSIGN_ITEM_FROM_IDENTITY':
                response = await handleUnassignItemFromIdentity(message.payload);
                break;
            case 'UPDATE_ITEM_LAST_USED':
                response = await handleUpdateItemLastUsed(message.payload);
                break;
            case 'WEBAUTHN_PREPARE':
                response = await handleWebAuthnPrepare(message.payload);
                break;
            case 'WEBAUTHN_CREATE':
                response = await handleWebAuthnCreate(message.payload);
                break;
            case 'WEBAUTHN_GET':
                response = await handleWebAuthnGet(message.payload);
                break;
            case 'OPEN_VAULT_UNLOCK':
                chrome.tabs.create({ url: chrome.runtime.getURL('vault.html?action=unlock') });
                response = { success: true };
                break;
            case 'QUEUE_SAVE_PROMPT':
                response = await handleQueueSavePrompt(message.payload, sender.tab?.id);
                break;
            case 'GET_PENDING_SAVE':
                response = handleGetPendingSave(sender.tab?.id);
                break;
            case 'CLEAR_PENDING_SAVE':
                if (sender.tab?.id !== undefined) pendingSaves.delete(sender.tab.id);
                response = { success: true };
                break;
            case 'SAVE_LOGIN_FROM_PAGE':
                response = await handleSaveLoginFromPage(message.payload);
                break;
            default:
                response = { success: false, error: 'Unknown message type' };
        }

        sendResponse(response);
    })();

    return true;
});

chrome.runtime.onInstalled.addListener(() => {
    console.log('VaultWares Identity Manager installed');
    startAutoSync();
});

startAutoSync();
