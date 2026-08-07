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
import { fetchAccountKey, putAccountKey, getIdentityVaultId, fetchSealedKeychain, putSealedKeychain } from '../api/warden';
import { buildEnrollment, validateMasterPassword, type EnrollmentState } from '../crypto/enrollment';
import { openAccountKeyBlob, openPortableKeychain, fromPortableKeychain } from '../crypto/account-key';
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
    | 'OPEN_VAULT'
    | 'GET_SYNC_STATUS'
    | 'GET_PAGE_IDENTITIES'
    | 'TOUCH_IDENTITY'
    | 'QUEUE_SAVE_PROMPT'
    | 'GET_PENDING_SAVE'
    | 'CLEAR_PENDING_SAVE'
    | 'SAVE_LOGIN_FROM_PAGE'
    | 'GET_ENROLLMENT_STATE'
    | 'ENROLL_MASTER_PASSWORD'
    | 'BOOTSTRAP_FROM_MASTER_PASSWORD';

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
    /** False when vault-warden could not be reached for this answer. */
    reachable?: boolean;
    /**
     * The vault was locked, so `data` is empty because nothing could be
     * decrypted — not because there is nothing stored.
     *
     * Without this the UI cannot tell those two apart and renders its empty
     * state, which looks exactly like the vault has been wiped.
     */
    locked?: boolean;
}

let lockTimer: ReturnType<typeof setTimeout> | null = null;

/* --------------------------------------------------------- vault tab */

/**
 * Opens the vault, reusing the tab if one is already open.
 *
 * Every entry point used to call `chrome.tabs.create`, so following a few
 * "create item for this site" links left a row of identical vault tabs, each
 * with its own unlock state and stale item list.
 */
async function openVaultTab(query = ''): Promise<void> {
    const url = chrome.runtime.getURL(`vault.html${query}`);
    const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('vault.html') + '*' });

    const tab = existing[0];
    if (tab?.id !== undefined) {
        await chrome.tabs.update(tab.id, { url, active: true });
        if (tab.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
        return;
    }
    await chrome.tabs.create({ url });
}

/* ------------------------------------------------------- toolbar cue */

let badgeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Marks a successful save on the toolbar icon.
 *
 * Deliberately a small dot rather than a count or a word: it should read as
 * "that worked" at a glance and not demand attention. It lingers well past a
 * toast because the user is usually still on the page, mid-flow, and looks up
 * only after finishing what they were doing.
 */
function flashSavedBadge(): void {
    if (badgeTimer) clearTimeout(badgeTimer);

    void chrome.action.setBadgeText({ text: '•' });
    void chrome.action.setBadgeBackgroundColor({ color: '#D6A441' });
    if (chrome.action.setBadgeTextColor) {
        void chrome.action.setBadgeTextColor({ color: '#0b0813' });
    }

    badgeTimer = setTimeout(() => {
        void chrome.action.setBadgeText({ text: '' });
        badgeTimer = null;
    }, 20_000);
}

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
            return { success: false, error: 'Vault is locked', locked: true };
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
        flashSavedBadge();

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
        flashSavedBadge();

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

export interface SyncStatus {
    state: 'idle' | 'syncing' | 'ok' | 'error';
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    pushed: number;
    pulled: number;
    error: string | null;
}

/**
 * Sync ran silently every 60s with no way to tell whether it worked. Tracked
 * here so the UI can say so — a vault that claims to sync and gives no feedback
 * is indistinguishable from one that is quietly failing.
 */
let syncStatus: SyncStatus = {
    state: 'idle',
    lastAttemptAt: null,
    lastSuccessAt: null,
    pushed: 0,
    pulled: 0,
    error: null,
};

async function handleSync(): Promise<MessageResponse> {
    syncStatus = { ...syncStatus, state: 'syncing', error: null, lastAttemptAt: new Date().toISOString() };
    try {
        const queueResult = await processQueue();
        const syncResult = await fullSync();

        syncStatus = {
            ...syncStatus,
            // fullSync swallows transport errors and reports ok:false rather
            // than throwing, so a green tick here would be a lie without it.
            state: syncResult.ok ? 'ok' : 'error',
            lastSuccessAt: syncResult.ok ? new Date().toISOString() : syncStatus.lastSuccessAt,
            pushed: syncResult.pushed,
            pulled: syncResult.pulled,
            error: syncResult.ok ? null : 'Could not reach the local vault-warden',
        };

        return { success: true, data: { ...syncResult, ...queueResult, status: syncStatus } };
    } catch (e) {
        syncStatus = { ...syncStatus, state: 'error', error: (e as Error).message };
        return { success: false, error: (e as Error).message };
    }
}

function handleGetSyncStatus(): MessageResponse {
    return { success: true, data: syncStatus };
}

async function handleGetPageMatches(payload: { url: string }): Promise<MessageResponse> {
    try {
        const items = await getEncryptedItems();
        const kemSecretKey = await getKemSecretKey();
        const sigKp = await getSigKeyPair();

        if (!kemSecretKey || !sigKp) return { success: true, data: [], locked: true };

        const masterKey = await getCachedMasterKey();
        if (!masterKey) return { success: true, data: [], locked: true };

        const { matchStrength, MATCH_NONE } = await import('../utils/domain');

        // Ranked, not filtered: a credential saved for this exact subdomain
        // should outrank one saved for a sibling of the same parent domain.
        const scored: { item: VaultItem; strength: number }[] = [];

        for (const enc of items) {
            if (enc.deletedAt) continue;

            let strength = matchStrength(enc.envelope.metadata.domain || '', payload.url);

            // The stored URL can be more specific than metadata.domain, which
            // older versions flattened to the registrable domain.
            let item: VaultItem | null = null;
            if (enc.envelope.itemType === 'login' || strength > MATCH_NONE) {
                try {
                    item = openEnvelope(enc, kemSecretKey, sigKp.publicKey);
                } catch (e) {
                    console.error('Failed to decrypt item:', enc.id, e);
                    continue;
                }
            }
            if (!item) continue;

            if (item.itemType === 'login') {
                const login = item.data as import('../types').LoginItem;
                if (login.url) {
                    strength = Math.max(strength, matchStrength(login.url, payload.url));
                }
            }

            if (strength > MATCH_NONE) scored.push({ item, strength });
        }

        scored.sort((a, b) => {
            if (a.strength !== b.strength) return b.strength - a.strength;
            return (b.item.lastUsedAt ?? '').localeCompare(a.item.lastUsedAt ?? '');
        });

        return { success: true, data: scored.map(s => s.item) };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

/**
 * Identities offered for autofill on a page, most relevant first.
 *
 * Identities are not domain-scoped the way logins are — a persona is meant to
 * be reusable across sites. But one that already owns an item on this domain is
 * the one you almost certainly want, so it sorts to the top; the rest follow by
 * recency. Without this the content script never sees identities at all and a
 * saved persona can never fill an address form.
 */
async function handleGetPageIdentities(payload: { url: string }): Promise<MessageResponse> {
    try {
        const identitiesResponse = await handleGetIdentities();
        if (identitiesResponse.locked || !identitiesResponse.success) return identitiesResponse;

        const identities = (identitiesResponse.data ?? []) as Identity[];
        if (identities.length === 0) return { success: true, data: [] };

        const matchesResponse = await handleGetPageMatches(payload);
        const domainItems = (matchesResponse.data ?? []) as VaultItem[];
        const domainIdentityIds = new Set(
            domainItems.map(item => item.identityId).filter((id): id is string => !!id),
        );

        const ranked = [...identities].sort((a, b) => {
            const aLinked = domainIdentityIds.has(a.id);
            const bLinked = domainIdentityIds.has(b.id);
            if (aLinked !== bLinked) return aLinked ? -1 : 1;
            if (a.metadata.favorite !== b.metadata.favorite) return a.metadata.favorite ? -1 : 1;
            return (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '');
        });

        return {
            success: true,
            data: ranked.map(identity => ({
                identity,
                linkedToDomain: domainIdentityIds.has(identity.id),
            })),
        };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

/** Records that an identity was used, so it ranks higher next time. */
async function handleTouchIdentity(payload: { id: string }): Promise<MessageResponse> {
    try {
        const response = await handleGetIdentities();
        if (!response.success) return response;

        const identity = (response.data as Identity[]).find(i => i.id === payload.id);
        if (!identity) return { success: false, error: 'Identity not found' };

        return handleUpdateIdentity({
            identity: { ...identity, lastUsedAt: new Date().toISOString() },
        });
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
        if (!kemSecretKey || !sigKp) return { success: true, data: [], locked: true };

        const masterKey = await getCachedMasterKey();
        if (!masterKey) return { success: true, data: [], locked: true };

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
        flashSavedBadge();

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
 * Kept in `chrome.storage.session`, not a module-level Map. A submit that
 * navigates tears down the content script before the user can answer, so the
 * pending save must survive one page load — and an MV3 service worker is
 * evicted when idle, which would take a Map with it exactly during that gap.
 * Session storage is memory-backed and cleared when the browser closes, so the
 * plaintext password still never reaches disk.
 */
const PENDING_SAVE_KEY = 'vw_pending_saves';
const PENDING_SAVE_TTL_MS = 2 * 60 * 1000;

async function readPendingSaves(): Promise<Record<string, PendingSave>> {
    const stored = await chrome.storage.session.get(PENDING_SAVE_KEY) as Record<string, any>;
    const all = (stored[PENDING_SAVE_KEY] as Record<string, PendingSave>) ?? {};

    const now = Date.now();
    const live: Record<string, PendingSave> = {};
    for (const [tabId, pending] of Object.entries(all)) {
        if (pending.expiresAt > now) live[tabId] = pending;
    }
    return live;
}

async function writePendingSave(tabId: number, pending: PendingSave | null): Promise<void> {
    const all = await readPendingSaves();
    if (pending) all[String(tabId)] = pending;
    else delete all[String(tabId)];
    await chrome.storage.session.set({ [PENDING_SAVE_KEY]: all });
}

chrome.tabs.onRemoved.addListener(tabId => { void writePendingSave(tabId, null); });

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

    const actionable = decision.status === 'new'
        || (decision.status === 'existing' && !(decision as PendingSave['decision']).samePassword);

    if (tabId !== undefined && actionable) {
        await writePendingSave(tabId, {
            ...payload,
            decision: decision as PendingSave['decision'],
            expiresAt: Date.now() + PENDING_SAVE_TTL_MS,
        });
    }

    return { success: true, data: decision };
}

async function handleGetPendingSave(tabId: number | undefined): Promise<MessageResponse> {
    if (tabId === undefined) return { success: true, data: null };
    const all = await readPendingSaves();
    return { success: true, data: all[String(tabId)] ?? null };
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

/* ------------------------------------------------------- enrollment */

const ENROLLED_AT_KEY = 'vw_enrolled_at';

/**
 * What this device can do about multi-device right now.
 *
 * Reported rather than inferred in the UI because three of the four states look
 * identical from the extension's own storage — the difference is whether the
 * server already holds an account key, which only a round trip can answer.
 */
async function handleGetEnrollmentState(): Promise<MessageResponse> {
    if (!await isInitialized()) {
        return { success: true, data: { status: 'uninitialised' } satisfies EnrollmentState };
    }

    const stored = await chrome.storage.local.get(ENROLLED_AT_KEY) as Record<string, any>;
    const enrolledAt = stored[ENROLLED_AT_KEY] as string | undefined;

    let remoteKey = null;
    let reachable = true;
    try {
        remoteKey = await fetchAccountKey();
    } catch {
        reachable = false;
    }

    if (enrolledAt && remoteKey) {
        return { success: true, data: { status: 'enrolled', enrolledAt } satisfies EnrollmentState, reachable };
    }
    if (remoteKey) {
        return { success: true, data: { status: 'remote-available' } satisfies EnrollmentState, reachable };
    }
    return { success: true, data: { status: 'local-only' } satisfies EnrollmentState, reachable };
}

/**
 * Sets a master password on a vault that currently has only a local PIN.
 *
 * Requires the vault to be unlocked, because the master key it wraps only
 * exists in memory while it is. Items are untouched: the password wraps the
 * master key, and the master key is what items are sealed under.
 */
async function handleEnrollMasterPassword(payload: { password: string; confirmation: string }): Promise<MessageResponse> {
    try {
        const check = validateMasterPassword(payload.password, payload.confirmation);
        if (!check.ok) return { success: false, error: check.reason };

        const masterKey = await getCachedMasterKey();
        if (!masterKey) return { success: false, error: 'Unlock the vault before setting a master password', locked: true };

        const keychain = await getKeychain();
        if (!keychain) return { success: false, error: 'Keychain not initialised' };

        // Throws if the blobs do not round-trip, before anything is uploaded.
        const bundle = buildEnrollment(masterKey, keychain, payload.password);

        const vaultId = await getIdentityVaultId();
        await putAccountKey(bundle.accountKey);
        await putSealedKeychain(vaultId, bundle.sealedKeychain);

        const enrolledAt = new Date().toISOString();
        await chrome.storage.local.set({ [ENROLLED_AT_KEY]: enrolledAt });
        flashSavedBadge();

        return { success: true, data: { status: 'enrolled', enrolledAt } satisfies EnrollmentState };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

/**
 * Brings a device online from the master password alone.
 *
 * This is the path a phone takes. Nothing local is written until the keychain
 * has been decrypted and parsed, so a wrong password or an unreachable server
 * leaves the device exactly as it was.
 */
async function handleBootstrapFromMasterPassword(payload: { password: string; pin?: string }): Promise<MessageResponse> {
    try {
        const accountKey = await fetchAccountKey();
        if (!accountKey) return { success: false, error: 'This account has no master password enrolled yet' };

        const masterKey = openAccountKeyBlob(accountKey, payload.password);
        if (!masterKey) return { success: false, error: 'Incorrect master password' };

        const vaultId = await getIdentityVaultId();
        const sealed = await fetchSealedKeychain(vaultId);
        if (!sealed) return { success: false, error: 'No keychain found on the server for this account' };

        const portable = openPortableKeychain(sealed, masterKey);
        const deviceId = (await getKeychain())?.deviceId ?? crypto.randomUUID();
        const state = fromPortableKeychain(portable, deviceId);

        await chrome.storage.local.set({ vw_keychain: state });
        await setCachedMasterKey(masterKey);

        // A local PIN is optional here; without one the master password is
        // required on every unlock.
        if (payload.pin) {
            await wrapAndStoreMasterKey(masterKey, payload.pin);
        }
        await chrome.storage.local.set({ [ENROLLED_AT_KEY]: new Date().toISOString() });
        resetLockTimer();

        return { success: true, data: { deviceId } };
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
                await openVaultTab('?action=create&url=' + encodeURIComponent(message.payload?.url || ''));
                response = { success: true };
                break;
            case 'OPEN_VAULT':
                await openVaultTab(message.payload?.query ?? '');
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
                await openVaultTab('?action=unlock');
                response = { success: true };
                break;
            case 'GET_SYNC_STATUS':
                response = handleGetSyncStatus();
                break;
            case 'GET_PAGE_IDENTITIES':
                response = await handleGetPageIdentities(message.payload);
                break;
            case 'TOUCH_IDENTITY':
                response = await handleTouchIdentity(message.payload);
                break;
            case 'QUEUE_SAVE_PROMPT':
                response = await handleQueueSavePrompt(message.payload, sender.tab?.id);
                break;
            case 'GET_PENDING_SAVE':
                response = await handleGetPendingSave(sender.tab?.id);
                break;
            case 'CLEAR_PENDING_SAVE':
                if (sender.tab?.id !== undefined) await writePendingSave(sender.tab.id, null);
                response = { success: true };
                break;
            case 'GET_ENROLLMENT_STATE':
                response = await handleGetEnrollmentState();
                break;
            case 'ENROLL_MASTER_PASSWORD':
                response = await handleEnrollMasterPassword(message.payload);
                break;
            case 'BOOTSTRAP_FROM_MASTER_PASSWORD':
                response = await handleBootstrapFromMasterPassword(message.payload);
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
