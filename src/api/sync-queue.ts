import { getEncryptedItems, getSyncCursor, setSyncCursor, replaceAllEncryptedItems } from '../utils/storage';
import { pushChanges, pullChanges } from '../api/sync';
import type { EncryptedVaultItem } from '../types';
import { localStore } from '../platform/store';
import { getKeychain } from '../crypto/keychain';
import { isSignedByThisAccount } from '../crypto/envelope';
import { fromBase64 } from '../crypto/pqc';

const QUEUE_KEY = 'vw_sync_queue';

interface QueueEntry {
    id: string;
    operation: 'create' | 'update' | 'delete';
    itemId: string;
    envelope?: any;
    attempts: number;
    createdAt: string;
}

async function getQueue(): Promise<QueueEntry[]> {
    const result = await localStore.get(QUEUE_KEY);
    return (result[QUEUE_KEY] as QueueEntry[]) ?? [];
}

async function saveQueue(queue: QueueEntry[]): Promise<void> {
    await localStore.set({ [QUEUE_KEY]: queue });
}

/**
 * Drops everything waiting to be pushed.
 *
 * For device reset: queued entries carry envelopes sealed to a keypair that is
 * about to stop existing, and pushing them after rotation would put items the
 * new keychain cannot open back into the vault.
 */
export async function clearQueue(): Promise<void> {
    await saveQueue([]);
}

export async function enqueueCreate(item: EncryptedVaultItem): Promise<void> {
    const queue = await getQueue();
    queue.push({
        id: crypto.randomUUID(),
        operation: 'create',
        itemId: item.id,
        envelope: item.envelope,
        attempts: 0,
        createdAt: new Date().toISOString(),
    });
    await saveQueue(queue);
}

export async function enqueueUpdate(item: EncryptedVaultItem): Promise<void> {
    const queue = await getQueue();
    const existing = queue.find(q => q.itemId === item.id && q.operation === 'create');
    if (existing) {
        existing.envelope = item.envelope;
        await saveQueue(queue);
        return;
    }
    queue.push({
        id: crypto.randomUUID(),
        operation: 'update',
        itemId: item.id,
        envelope: item.envelope,
        attempts: 0,
        createdAt: new Date().toISOString(),
    });
    await saveQueue(queue);
}

export async function enqueueDelete(itemId: string): Promise<void> {
    const queue = await getQueue();
    const filtered = queue.filter(q => q.itemId !== itemId && q.operation !== 'delete');
    filtered.push({
        id: crypto.randomUUID(),
        operation: 'delete',
        itemId,
        attempts: 0,
        createdAt: new Date().toISOString(),
    });
    await saveQueue(filtered);
}

let processing = false;

// A deletion propagated to the server. Deleted items are removed from local
// storage, so we carry an explicit tombstone (no envelope) in the push batch.
export interface SyncTombstone {
    id: string;
    envelope: null;
    deletedAt: string;
}

export async function processQueue(): Promise<{ processed: number; failed: number }> {
    if (processing) return { processed: 0, failed: 0 };
    processing = true;

    try {
        const queue = await getQueue();
        // The local endpoints speak the batch push/pull protocol rather than
        // per-item CRUD, so a single fullSync covers all queued work. Queued
        // deletes become tombstones; everything else is captured by pushing the
        // current local item set.
        const tombstones: SyncTombstone[] = queue
            .filter(q => q.operation === 'delete')
            .map(q => ({ id: q.itemId, envelope: null, deletedAt: new Date().toISOString() }));

        const result = await fullSync(tombstones);
        if (result.ok) {
            await saveQueue([]);
            return { processed: queue.length, failed: 0 };
        }
        // Leave the queue in place; startAutoSync retries on its interval.
        return { processed: 0, failed: queue.length };
    } finally {
        processing = false;
    }
}

export async function fullSync(
    extraDeletes: SyncTombstone[] = [],
): Promise<{ pushed: number; pulled: number; foreign: number; ok: boolean }> {
    try {
        // Envelopes not signed by the current account are dropped on both legs.
        // After a key rotation the server still holds items sealed by the
        // retired keychain; without this they are pulled into local storage,
        // pushed back on the next round, and multiply across every device while
        // being permanently unopenable. Signature verification needs only the
        // public half, so this works while the vault is locked — which is when
        // the timer-driven sync usually runs.
        const keychain = await getKeychain();
        if (!keychain?.sigPublicKey) {
            // No account yet, or mid-reset. Syncing here would push whatever
            // happens to be left in storage against an account it may not
            // belong to.
            return { pushed: 0, pulled: 0, foreign: 0, ok: false };
        }
        const sigPublicKey = fromBase64(keychain.sigPublicKey);
        const isOurs = (item: EncryptedVaultItem) => isSignedByThisAccount(item, sigPublicKey);

        const storedItems = await getEncryptedItems();
        const localItems = storedItems.filter(isOurs);
        const droppedLocally = storedItems.length - localItems.length;

        const cursor = await getSyncCursor();

        const pushPayload = [...localItems, ...extraDeletes];
        const pushResp = await pushChanges(pushPayload, cursor);
        await setSyncCursor(pushResp.cursor);

        const pullResp = await pullChanges(pushResp.cursor);
        await setSyncCursor(pullResp.cursor);

        const merged = [...localItems];
        let foreignFromServer = 0;
        for (const remoteItem of pullResp.items) {
            const idx = merged.findIndex(i => i.id === remoteItem.id);
            if (remoteItem.deletedAt) {
                // Remote tombstone wins — drop it locally.
                if (idx >= 0) merged.splice(idx, 1);
                continue;
            }
            if (!isOurs(remoteItem)) {
                foreignFromServer += 1;
                continue;
            }
            if (idx >= 0) {
                const remoteUpdated = new Date(remoteItem.envelope.updatedAt).getTime();
                const localUpdated = new Date(merged[idx].envelope.updatedAt).getTime();
                if (remoteUpdated > localUpdated) {
                    merged[idx] = remoteItem;
                }
            } else {
                merged.push(remoteItem);
            }
        }

        // Rewrites storage even when nothing came down, so items dropped above
        // stop being re-read and re-pushed forever.
        await replaceAllEncryptedItems(merged);
        return {
            pushed: pushPayload.length,
            pulled: pullResp.items.length,
            foreign: droppedLocally + foreignFromServer,
            ok: true,
        };
    } catch (e) {
        console.warn('Full sync failed:', e);
        return { pushed: 0, pulled: 0, foreign: 0, ok: false };
    }
}

let syncTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoSync(intervalMs: number = 60000): void {
    if (syncTimer) clearInterval(syncTimer);
    processQueue();
    syncTimer = setInterval(() => processQueue(), intervalMs);
}

export function stopAutoSync(): void {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
    }
}
